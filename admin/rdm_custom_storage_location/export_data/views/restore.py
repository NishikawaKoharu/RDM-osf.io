from __future__ import absolute_import

import logging

from celery.contrib.abortable import AbortableAsyncResult
from django.utils.decorators import method_decorator
from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework.views import APIView

from admin.rdm.utils import RdmPermissionMixin
from admin.rdm_custom_storage_location import tasks

from addons.osfstorage.models import Region
from admin.rdm_custom_storage_location.export_data import serializers, utils

from django.db import transaction
from osf.models import ExportData, ExportDataLocation, ExportDataRestore, BaseFileNode, \
    FileInfo, FileLog, FileVersion, FileMetadataRecord, FileMetadataSchema
from django.utils import timezone

from website.settings import WATERBUTLER_URL

logger = logging.getLogger(__name__)
DATETIME_FORMAT = "%Y%m%dT%H%M%S"
EXPORT_FILE_PATH = "/export_{source_id}_{process_start}/export_data_{institution_guid}_{process_start}.json"
EXPORT_FILE_INFO_PATH = "/export_{source_id}_{process_start}/file_info_{institution_guid}_{process_start}.json"
NODE_ID = 'export_location'


@method_decorator(transaction.non_atomic_requests, name='dispatch')
class ExportDataRestoreView(RdmPermissionMixin, APIView):
    raise_exception = True

    def post(self, request, **kwargs):
        source_id = request.POST.get('source_id')
        destination_id = request.POST.get('destination_id')
        export_id = self.kwargs.get('export_id')
        cookies = request.COOKIES
        is_from_confirm_dialog = request.POST.get('is_from_confirm_dialog', default=False)
        if source_id is None or destination_id is None or export_id is None:
            return Response({}, status=status.HTTP_400_BAD_REQUEST)

        if not is_from_confirm_dialog:
            # Check the destination is available (not in restore process or checking restore data process)
            any_process_running = utils.check_any_running_restore_process(destination_id)
            if any_process_running:
                return Response({"error_message": f"Cannot restore in this time."}, status=status.HTTP_400_BAD_REQUEST)

            result = check_before_restore_export_data(cookies, export_id, source_id, destination_id)
            if result["open_dialog"]:
                # If open_dialog is True, return HTTP 200 with empty response
                return Response({}, status=status.HTTP_200_OK)
            elif result["error_message"]:
                # If there is error message, return HTTP 400
                return Response({'error_message': result["error_message"]}, status=status.HTTP_400_BAD_REQUEST)
            else:
                # Otherwise, start restore data task and return task id
                # Recheck the destination is available (not in restore process or checking restore data process)
                any_process_running = utils.check_any_running_restore_process(destination_id)
                if any_process_running:
                    return Response({"error_message": f"Cannot restore in this time."},
                                    status=status.HTTP_400_BAD_REQUEST)

                # Try to add new process record to DB
                export_data_restore = ExportDataRestore(export_id=export_id, destination_id=destination_id,
                                                        status=ExportData.STATUS_RUNNING)
                export_data_restore.save()
                process = tasks.run_restore_export_data_process.delay(cookies, export_id, source_id, destination_id, export_data_restore.pk)
                return Response({'task_id': process.task_id}, status=status.HTTP_200_OK)
        else:
            # Check the destination is available (not in restore process or checking restore data process)
            any_process_running = utils.check_any_running_restore_process(destination_id)
            if any_process_running:
                return Response({"error_message": f"Cannot restore in this time."}, status=status.HTTP_400_BAD_REQUEST)

            # Try to add new process record to DB
            export_data_restore = ExportDataRestore(export_id=export_id, destination_id=destination_id,
                                                    status=ExportData.STATUS_RUNNING)
            export_data_restore.save()
            # If user clicked 'Restore' button in confirm dialog, start restore data task and return task id
            process = tasks.run_restore_export_data_process.delay(cookies, export_id, source_id, destination_id, export_data_restore.pk)
            return Response({'task_id': process.task_id}, status=status.HTTP_200_OK)


@api_view(http_method_names=["POST"])
def stop_export_data_restore(request, *args, **kwargs):
    task_id = request.POST.get('task_id')
    source_id = request.POST.get('source_id')
    destination_id = request.POST.get('destination_id')
    export_id = kwargs.get('export_id')
    cookies = request.COOKIES

    if source_id is None or destination_id is None or export_id is None or task_id is None:
        return Response({}, status=status.HTTP_400_BAD_REQUEST)

    # Rollback restore data
    rollback_restore(cookies, export_id, source_id, destination_id, task_id)
    return Response({}, status=status.HTTP_200_OK)


class ExportDataRestoreTaskStatusView(RdmPermissionMixin, APIView):
    def get(self, request, **kwargs):
        task_id = request.GET.get('task_id')
        if task_id is None:
            return Response({}, status=status.HTTP_400_BAD_REQUEST)
        task = AbortableAsyncResult(task_id)
        response = {
            'state': task.state,
        }
        if task.result is not None:
            response = {
                'state': task.state,
                'result': task.result if isinstance(task.result, str) or isinstance(task.result, dict) else {},
            }
        return Response(response, status=status.HTTP_200_OK)


def check_before_restore_export_data(cookies, export_id, source_id, destination_id):
    # Get export file (/export_{process_start}/export_data_{institution_guid}_{process_start}.json)
    export_data = ExportData.objects.filter(id=export_id, is_deleted=False)[0]
    export_base_url, export_settings, export_institution_guid = ExportDataLocation.objects.filter(id=export_data.location_id).values_list('waterbutler_url', 'waterbutler_settings', 'institution_guid')[0]
    export_provider = export_settings["storage"]["provider"]
    export_file_path = EXPORT_FILE_PATH.format(institution_guid=export_institution_guid, source_id=source_id,
                                               process_start=export_data.process_start.strftime(DATETIME_FORMAT))
    internal = export_base_url == WATERBUTLER_URL
    try:
        response = utils.get_file_data(NODE_ID, export_provider, export_file_path, cookies, internal, export_base_url)
        if response.status_code != 200:
            # Error
            logger.error(f"Return error with response: {response.content}")
            response.close()
            return {'open_dialog': False, "error_message": f"Cannot connect to the export data storage location"}
        response_body = response.content
        response_file_content = response_body.decode('utf-8')
        response.close()
    except Exception as e:
        logger.error(f"Exception: {e}")
        return {'open_dialog': False, "error_message": f"Cannot connect to the export data storage location"}

    # Validate export file schema
    is_file_valid = utils.validate_file_json(response_file_content, serializers.ExportDataSerializer)
    if not is_file_valid:
        return {'open_dialog': False, "error_message": f"The export data files are corrupted"}

    # Check whether the restore destination storage is not empty
    destination_region = Region.objects.filter(id=destination_id)
    destination_base_url, destination_guid, destination_settings = destination_region.values_list("waterbutler_url", "_id", "waterbutler_settings")[0]
    destination_provider = destination_settings["storage"]["provider"]
    internal = destination_base_url == WATERBUTLER_URL
    try:
        response = utils.get_file_data('emx94', destination_provider, "/", cookies, internal, destination_base_url,
                                       get_file_info=True)
        if response.status_code != 200:
            # Error
            logger.error(f"Return error with response: {response.content}")
            response.close()
            return {'open_dialog': False, "error_message": f"Cannot connect to destination storage"}
    except Exception as e:
        logger.error(f"Exception: {e}")
        return {'open_dialog': False, "error_message": f"Cannot connect to destination storage"}

    response_body = response.json()
    data = response_body["data"]
    response.close()
    if len(data) != 0:
        # Destination storage is not empty, show confirm dialog
        return {'open_dialog': True}

    # Destination storage is empty, return False
    return {'open_dialog': False}


def restore_export_data_process(cookies, export_id, source_id, destination_id, export_data_restore_id):
    try:
        export_data_restore = ExportDataRestore.objects.get(id=export_data_restore_id)

        # Check destination storage type (bulk-mounted or add-on)
        is_destination_addon_storage = utils.check_storage_type(destination_id)
        if is_destination_addon_storage:
            # If destination storage is add-on institutional storage,
            # move all old data in restore destination storage to a folder to back up (such as '_backup' folder)
            destination_region = Region.objects.filter(id=destination_id)
            destination_base_url, destination_guid, destination_settings = destination_region.values_list("waterbutler_url", "_id", "waterbutler_settings")[0]
            destination_provider = destination_settings["storage"]["provider"]
            internal = destination_base_url == WATERBUTLER_URL
            try:
                response = utils.move_file('emx94', destination_provider, source_file_path="/",
                                           destination_file_path="/_backup/", cookies=cookies,
                                           internal=internal, base_url=destination_base_url)
                if response.status_code != 200 and response.status_code != 201 and response.status_code != 202:
                    # Error
                    logger.error(f"Return error with response: {response.content}")
                    response.close()
                    export_data_restore.status = ExportData.STATUS_STOPPED
                    export_data_restore.save()
                    return {"error_message": f""}
            except Exception as e:
                logger.error(f"Exception: {e}")
                export_data_restore.status = ExportData.STATUS_STOPPED
                export_data_restore.save()
                return {"error_message": f""}

        with transaction.atomic():
            # Get file which have same information between export data and database
            # File info file: /export_{process_start}/file_info_{institution_guid}_{process_start}.json
            export_data = ExportData.objects.filter(id=export_id, is_deleted=False)[0]
            export_base_url, export_settings, export_institution_guid = ExportDataLocation.objects.filter(id=export_data.location_id).values_list('waterbutler_url', 'waterbutler_settings', 'institution_guid')[0]
            export_provider = export_settings["storage"]["provider"]
            file_info_path = EXPORT_FILE_INFO_PATH.format(
                institution_guid=export_institution_guid, source_id=source_id,
                process_start=export_data.process_start.strftime(DATETIME_FORMAT))
            internal = export_base_url == WATERBUTLER_URL
            try:
                response = utils.get_file_data(NODE_ID, export_provider, file_info_path, cookies, internal,
                                               export_base_url)
                if response.status_code != 200:
                    # Error
                    logger.error(f"Return error with response: {response.content}")
                    response.close()
                    export_data_restore.status = ExportData.STATUS_STOPPED
                    export_data_restore.save()
                    return {"error_message": f"Cannot get file infomation list"}
            except Exception as e:
                logger.error(f"Exception: {e}")
                export_data_restore.status = ExportData.STATUS_STOPPED
                export_data_restore.save()
                return {"error_message": f"Cannot get file infomation list"}

            response_body = response.json()
            response.close()

            # Validate file info schema
            is_file_valid = utils.validate_file_json(response_body, serializers.FileInfoSerializer)
            if not is_file_valid:
                return {"error_message": f"The export data files are corrupted"}

            files = response_body["files"]
            destination_file_info = []
            destination_file_latest_versions = []
            is_export_addon_storage = utils.check_storage_type(export_id)
            for file in files:
                file_path = file["path"]
                file_materialized_path = file["materialized_path"]
                file_created_at = file["created_at"]
                file_modified_at = file["modified_at"]
                file_version = file["version"]["identifier"]

                # Get file which have the following information that is the same between export data and database
                file_node = BaseFileNode.active.filter(path=file_path, materialzed_path=file_materialized_path,
                                                       created_at=file_created_at, modified_at=file_modified_at)
                if len(file_node) == 0:
                    # File not match with DB, pass this file
                    continue

                # List file paths with the latest version
                if not is_export_addon_storage:
                    index = next((i for i, item in destination_file_latest_versions if item["path"] == file_materialized_path), -1)
                    if index == -1:
                        destination_file_latest_versions.append({"path": file_materialized_path, "latest_version": file_version})
                    else:
                        current_version = destination_file_latest_versions[index]["latest_version"]
                        destination_file_latest_versions[index]["latest_version"] = max(current_version, file_version)
                destination_file_info.append(file)

            for file in destination_file_info:
                file_path = file["path"]
                file_materialized_path = file["materialized_path"]
                # Prepare file name and file path for uploading
                # If the destination storage is add-on institutional storage and export data storage is bulk-mounted storage:
                # - for past version files, rename and save each version as filename_{version} in '_version_files' folder
                # - the latest version is saved as the original
                if is_destination_addon_storage and not is_export_addon_storage:
                    new_file_materialized_path = file_materialized_path
                    if len(file_materialized_path) > 0:
                        file_version = file["version"]["identifier"]
                        eariler_verison_index = next((item for item in destination_file_latest_versions if item["path"] == file_materialized_path and item["latest_version"] > file_version), -1)
                        if eariler_verison_index != -1:
                            # for past version files, rename and save each version as filename_{version} in '_version_files' folder
                            path_splits = new_file_materialized_path.split("/")

                            # add _{version} to file name
                            file_name = path_splits[len(path_splits) - 1]
                            file_splits = file_name.split(".")
                            file_splits[0] = file_splits[0] + "_{}".format(file_version)
                            versioned_file_name = ".".join(file_splits)

                            # add _version_files to folder path
                            path_splits.insert(len(path_splits) - 2, "_version_files")
                            path_splits[len(path_splits) - 1] = versioned_file_name
                            new_file_materialized_path = "/".join(path_splits)
                    new_file_path = new_file_materialized_path
                else:
                    new_file_path = file_path if is_export_addon_storage else file_materialized_path

                try:
                    # Download file from export data storage
                    internal = export_base_url == WATERBUTLER_URL
                    response = utils.get_file_data(NODE_ID, export_provider, file_materialized_path,
                                                   cookies, internal, export_base_url)
                    if response.status_code != 200:
                        continue
                    download_data = response.content
                    response.close()

                    # Upload downloaded file to destination storage
                    destination_region = Region.objects.filter(id=destination_id)
                    destination_base_url, destination_settings = destination_region.values_list("waterbutler_url", "waterbutler_settings")[0]
                    destination_provider = destination_settings["storage"]["provider"]
                    internal = destination_base_url == WATERBUTLER_URL
                    response = utils.upload_file('emx94', destination_provider, '/', download_data, new_file_path,
                                                 cookies, internal, destination_base_url)
                    if response.status_code != 201:
                        continue
                    # Contain a WaterButler file entity that describes the new file
                    response_body = response.json()
                    response.close()

                    # Add matched file information to related tables such as osf_basefilenode, osf_fileversion, osf_basefileinfo, osf_filelog,...
                    # file_node.pk = None
                    # file_node.path = new_file_path
                    # file_node.materialized_path = new_file_materialized_path
                    # file_node.save()
                except Exception as e:
                    # Did not download or upload, pass this file
                    continue

            # Update process data with process_end timestamp and "Completed" status
            export_data_restore.process_end = timezone.now()
            export_data_restore.status = ExportData.STATUS_COMPLETED
            export_data_restore.save()
    except Exception as e:
        logger.error(f"Exception: {e}")
        export_data_restore = ExportDataRestore.objects.get(id=export_data_restore_id)
        export_data_restore.status = ExportData.STATUS_STOPPED
        export_data_restore.save()
        raise e

    return {}


def rollback_restore(cookies, export_id, source_id, destination_id, task_id):
    try:
        export_data_restore = ExportDataRestore.objects.get(task_id=task_id)
    except Exception as e:
        return {"error_message": f"Cannot get export data restore info"}

    # Update process status
    export_data_restore.status = ExportData.STATUS_STOPPING
    export_data_restore.save()

    # Abort current task
    task = AbortableAsyncResult(task_id)
    task.abort()
    if task.state != 'ABORTED':
        return {"error_message": f"Cannot abort task"}

    # Rollback file movements
    # Get export data with the file information from the source storage via API call
    export_data = ExportData.objects.filter(id=export_id, is_deleted=False)[0]
    export_base_url, export_settings, export_institution_guid = ExportDataLocation.objects.filter(id=export_data.location_id).values_list('waterbutler_url', 'waterbutler_settings', 'institution_guid')[0]
    export_provider = export_settings["storage"]["provider"]
    file_info_path = EXPORT_FILE_INFO_PATH.format(
        institution_guid=export_institution_guid, source_id=source_id,
        process_start=export_data.modified.strftime(DATETIME_FORMAT))
    internal = export_base_url == WATERBUTLER_URL
    try:
        response = utils.get_file_data(NODE_ID, export_provider, file_info_path, cookies, internal, export_base_url)
        if response.status_code != 200:
            # Error
            logger.error(f"Return error with response: {response.content}")
            response.close()
            export_data_restore.status = ExportData.STATUS_STOPPED
            export_data_restore.save()
            return {"error_message": f"Cannot get file infomation list"}
    except Exception as e:
        logger.error(f"Exception: {e}")
        export_data_restore.status = ExportData.STATUS_STOPPED
        export_data_restore.save()
        return {"error_message": f"Cannot get file infomation list"}

    response_body = response.json()
    response.close()
    files = response_body["files"]

    # Validate file info schema
    is_file_valid = utils.validate_file_json(response_body, serializers.FileInfoSerializer)
    if not is_file_valid:
        return {"error_message": f"The export data files are corrupted"}

    # Check destination storage type (bulk-mounted or add-on)
    is_destination_addon_storage = utils.check_storage_type(destination_id)

    destination_region = Region.objects.filter(id=destination_id)
    destination_base_url, destination_guid, destination_settings = destination_region.values_list("waterbutler_url", "_id", "waterbutler_settings")[0]
    destination_provider = destination_settings["storage"]["provider"]
    internal = destination_base_url == WATERBUTLER_URL

    for file in files:
        file_path = file["path"]
        file_materialized_path = file["materialized_path"]
        # In add-on institutional storage: Delete files, except the backup folder.
        # In bulk-mounted institutional storage: Delete only files created during the restore process.
        try:
            response = utils.delete_file('emx94', destination_provider,
                                         file_materialized_path if is_destination_addon_storage else file_path, cookies)
            if response.status_code != 204:
                # Error
                logger.error(f"Return error with response: {response.content}")
                response.close()
                export_data_restore.status = ExportData.STATUS_STOPPED
                export_data_restore.save()
                return {"error_message": f"Failed to delete file"}
        except Exception as e:
            logger.error(f"Exception: {e}")
            export_data_restore.status = ExportData.STATUS_STOPPED
            export_data_restore.save()
            return {"error_message": f"Failed to delete file"}

    # If destination storage is add-on institutional storage
    if is_destination_addon_storage:
        # Move all files from the backup folder out
        try:
            response = utils.move_file('emx94', destination_provider, source_file_path="/_backup/",
                                       destination_file_path="/", cookies=cookies,
                                       internal=internal, base_url=destination_base_url)
            if response.status_code != 200 and response.status_code != 201 and response.status_code != 202:
                # Error
                logger.error(f"Return error with response: {response.content}")
                response.close()
                export_data_restore.status = ExportData.STATUS_STOPPED
                export_data_restore.save()
                return {"error_message": f"Failed to move backup folder to root"}
        except Exception as e:
            logger.error(f"Exception: {e}")
            export_data_restore.status = ExportData.STATUS_STOPPED
            export_data_restore.save()
            return {"error_message": f"Failed to move backup folder to root"}

        # Delete the backup folder
        try:
            response = utils.delete_file('emx94', destination_provider, "/_backup/", cookies, internal,
                                         destination_base_url)
            if response.status_code != 204:
                # Error
                logger.error(f"Return error with response: {response.content}")
                response.close()
                export_data_restore.status = ExportData.STATUS_STOPPED
                export_data_restore.save()
                return {"error_message": f"Failed to delete backup folder"}
        except Exception as e:
            logger.error(f"Exception: {e}")
            export_data_restore.status = ExportData.STATUS_STOPPED
            export_data_restore.save()
            return {"error_message": f"Failed to delete backup folder"}

    export_data_restore.status = ExportData.STATUS_STOPPED
    export_data_restore.save()
    return {}
