# -*- coding: utf-8 -*-
# Generated by Django 1.11.28 on 2023-06-26 08:39
from __future__ import unicode_literals

from django.db import migrations
from django.apps import apps

def add_source_name_to_existing_export_data(*args):
    ExportData = apps.get_model('osf.exportdata')
    Region = apps.get_model('addons_osfstorage', 'Region')

    export_data_list = ExportData.objects.filter(source_name=None)
    for data in export_data_list:
        source_id = data.source_id
        source_storage = Region.objects.get(pk=source_id)
        data.source_name = f'{source_storage.name} ({source_storage.provider_full_name})'
        data.save()

class Migration(migrations.Migration):

    dependencies = [
        ('osf', '0229_auto_20230620_0952'),
    ]

    operations = [
        migrations.RunPython(add_source_name_to_existing_export_data, migrations.RunPython.noop),
    ]
