import pytest
from framework.auth import Auth
from osf_tests.factories import ProjectFactory, InstitutionFactory, RegionFactory

from addons.osfstorage.tests import factories
from addons.osfstorage.tests.utils import StorageTestCase
from addons.onedrivebusiness import SHORT_NAME

@pytest.mark.django_db
class TestNonInstitutionalNodeSettings(StorageTestCase):
    def setUp(self):
        super(TestNonInstitutionalNodeSettings, self).setUp()
        self.user = factories.AuthUserFactory()
        self.node = ProjectFactory(creator=self.user)
        self.node.creator.add_addon(SHORT_NAME)
        self.institution = InstitutionFactory()
        self.osfstorage = self.node.get_addon('osfstorage')
        self.node.add_addon(SHORT_NAME, auth=Auth(user=self.user))
        self.node_settings = self.node.get_addon(SHORT_NAME)
        self.user_settings = self.user.get_addon(SHORT_NAME)
        self.node_settings.user_settings = self.user_settings
        self.node_settings.folder_id = 'some_folder'
        self.node_settings.save()

    def test_fields(self):
        assert self.node_settings._id
        assert self.node_settings.user_settings
        assert self.node_settings.has_auth is not False
        assert self.node_settings.complete is False

@pytest.mark.django_db
class TestTargetInstitutionalNodeSettings(StorageTestCase):
    def setUp(self):
        super(TestTargetInstitutionalNodeSettings, self).setUp()
        self.user = factories.AuthUserFactory()
        self.node = ProjectFactory(creator=self.user)
        self.node.creator.add_addon(SHORT_NAME)
        self.institution = InstitutionFactory()
        self.osfstorage = self.node.get_addon('osfstorage')
        new_region = RegionFactory(
            _id=self.institution._id,
            name='Institutional Storage',
            waterbutler_settings={
                'storage': {
                    'provider': SHORT_NAME,
                },
            }
        )
        self.osfstorage.region = new_region
        self.osfstorage.save()
        self.node.add_addon(SHORT_NAME, auth=Auth(user=self.user))
        self.node_settings = self.node.get_addon(SHORT_NAME)
        self.user_settings = self.user.get_addon(SHORT_NAME)
        self.node_settings.user_settings = self.user_settings
        self.node_settings.folder_id = 'some_folder'
        self.node_settings.save()

    def test_fields(self):
        assert self.node_settings._id
        assert self.node_settings.user_settings
        assert self.node_settings.has_auth is True
        assert self.node_settings.complete is True

@pytest.mark.django_db
class TestNonTargetInstitutionalNodeSettings(StorageTestCase):
    def setUp(self):
        super(TestNonTargetInstitutionalNodeSettings, self).setUp()
        self.user = factories.AuthUserFactory()
        self.node = ProjectFactory(creator=self.user)
        self.node.creator.add_addon(SHORT_NAME)
        self.institution = InstitutionFactory()
        self.osfstorage = self.node.get_addon('osfstorage')
        new_region = RegionFactory(
            _id=self.institution._id,
            name='Institutional Storage for Another Addon',
            waterbutler_settings={
                'storage': {
                    'provider': 'another_provider',
                },
            }
        )
        self.osfstorage.region = new_region
        self.osfstorage.save()
        self.node.add_addon(SHORT_NAME, auth=Auth(user=self.user))
        self.node_settings = self.node.get_addon(SHORT_NAME)
        self.user_settings = self.user.get_addon(SHORT_NAME)
        self.node_settings.user_settings = self.user_settings
        self.node_settings.folder_id = 'some_folder'
        self.node_settings.save()

    def test_fields(self):
        assert self.node_settings._id
        assert self.node_settings.user_settings
        assert self.node_settings.has_auth is not False
        assert self.node_settings.complete is False
