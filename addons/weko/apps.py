import os
from addons.base.apps import BaseAddonAppConfig, generic_root_folder
from addons.weko.settings import MAX_UPLOAD_SIZE

weko_root_folder = generic_root_folder('weko')

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_PATH = os.path.join(
    HERE,
    'templates'
)

SHORT_NAME = 'weko'
FULL_NAME = 'WEKO'
NAME = 'addons.weko'


class WEKOAddonAppConfig(BaseAddonAppConfig):

    name = NAME
    label = 'addons_weko'
    full_name = FULL_NAME
    short_name = SHORT_NAME
    owners = ['user', 'node']
    configs = ['accounts', 'node']
    categories = ['storage']
    has_hgrid_files = True

    # MAX_UPLOAD_SIZE is defined in bytes, but max_file_size must be defined in MB
    max_file_size = MAX_UPLOAD_SIZE // (1024 ** 2)

    node_settings_template = os.path.join(TEMPLATE_PATH, 'weko_node_settings.mako')
    user_settings_template = os.path.join(TEMPLATE_PATH, 'weko_user_settings.mako')

    # WEKO addon is not allowed by default
    # - It can be activated by the institution administrator.
    is_allowed_default = False

    @property
    def get_hgrid_data(self):
        return weko_root_folder

    INDEX_LINKED = 'weko_index_linked'
    FILE_ADDED = 'weko_file_added'
    FILE_REMOVED = 'weko_file_removed'
    FOLDER_CREATED = 'weko_folder_created'
    ITEM_DEPOSITED = 'weko_item_deposited'
    NODE_AUTHORIZED = 'weko_node_authorized'
    NODE_DEAUTHORIZED = 'weko_node_deauthorized'
    NODE_DEAUTHORIZED_NO_USER = 'weko_node_deauthorized_no_user'

    actions = (INDEX_LINKED,
        FILE_ADDED,
        FILE_REMOVED,
        FOLDER_CREATED,
        ITEM_DEPOSITED,
        NODE_AUTHORIZED,
        NODE_DEAUTHORIZED,
        NODE_DEAUTHORIZED_NO_USER)

    @property
    def routes(self):
        from . import routes
        return [routes.oauth_routes, routes.api_routes]

    @property
    def user_settings(self):
        return self.get_model('UserSettings')

    @property
    def node_settings(self):
        return self.get_model('NodeSettings')
