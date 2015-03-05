import re
import sha
import hmac
import time
import base64
import urllib
import hashlib

from bson import ObjectId

from dateutil.parser import parse

from boto.iam import IAMConnection
from boto.s3.cors import CORSConfiguration
from boto.exception import BotoServerError

from website.util import rubeus, web_url_for

from api import get_bucket_list
import settings as s3_settings


def adjust_cors(s3wrapper, clobber=False):
    """Set CORS headers on a bucket, removing pre-existing headers set by the
    OSF. Optionally clear all pre-existing headers.

    :param S3Wrapper s3wrapper: S3 wrapper instance
    :param bool clobber: Remove all pre-existing rules. Note: if this option
        is set to True, remember to warn or prompt the user first!

    """
    rules = s3wrapper.get_cors_rules()

    # Remove some / all pre-existing rules
    if clobber:
        rules = CORSConfiguration([])
    else:
        rules = CORSConfiguration([
            rule
            for rule in rules
            if 'osf-s3' not in (rule.id or '')
        ])

    # Add new rule
    rules.add_rule(
        ['PUT', 'GET'],
        s3_settings.ALLOWED_ORIGIN,
        allowed_header=['*'],
        id='osf-s3-{0}'.format(ObjectId()),
    )

    # Save changes
    s3wrapper.set_cors_rules(rules)


def get_bucket_drop_down(user_settings):
    try:
        return [
            bucket.name
            for bucket in get_bucket_list(user_settings)
        ]
    except BotoServerError:
        return None


def create_osf_user(access_key, secret_key, name):

    connection = IAMConnection(access_key, secret_key)

    user_name = u'osf-{0}'.format(ObjectId())

    try:
        connection.get_user(user_name)
    except BotoServerError:
        connection.create_user(user_name)

    try:
        connection.get_user_policy(
            user_name,
            s3_settings.OSF_USER_POLICY
        )
    except BotoServerError:
        connection.put_user_policy(
            user_name,
            s3_settings.OSF_USER_POLICY_NAME,
            s3_settings.OSF_USER_POLICY
        )

    response = connection.create_access_key(user_name)
    access_key = response['create_access_key_response']['create_access_key_result']['access_key']
    return user_name, access_key


def remove_osf_user(user_settings):
    connection = IAMConnection(user_settings.access_key, user_settings.secret_key)
    connection.delete_access_key(
        user_settings.access_key,
        user_settings.s3_osf_user
    )
    connection.delete_user_policy(
        user_settings.s3_osf_user,
        s3_settings.OSF_USER_POLICY_NAME
    )
    return connection.delete_user(user_settings.s3_osf_user)


def validate_bucket_name(name):
    validate_name = re.compile('^(?!.*(\.\.|-\.))[^.][a-z0-9\d.-]{2,61}[^.]$')
    return bool(validate_name.match(name))


def generate_signed_url(mime, file_name, s3):

    expires = int(time.time() + 10)
    amz_headers = 'x-amz-acl:private'

    request_to_sign = str("PUT\n\n{mime_type}\n{expires}\n{amz_headers}\n/{resource}".format(
        mime_type=mime, expires=expires, amz_headers=amz_headers, resource=s3.bucket + '/' + file_name))

    url = 'https://s3.amazonaws.com/{bucket}/{filename}'.format(
        filename=file_name, bucket=s3.bucket)

    signed = urllib.quote_plus(base64.encodestring(
        hmac.new(str(s3.user_settings.secret_key), request_to_sign, sha).digest()).strip())

    return '{url}?AWSAccessKeyId={access_key}&Expires={expires}&Signature={signed}'.format(url=url, access_key=s3.user_settings.access_key, expires=expires, signed=signed),
    #/blackhttpmagick

def serialize_urls(node_addon, user):

    node = node_addon.owner
    user_settings = node_addon.user_settings

    result = {
        'createBucket': node.api_url_for('create_new_bucket'),
        'importAuth': node.api_url_for('s3_node_import_auth'),
        'createAuth': node.api_url_for('s3_authorize_node'),
        'deauthorize': node.api_url_for('s3_remove_node_settings'),
        'bucketList': node.api_url_for('s3_bucket_list'),
        'setBucket': node.api_url_for('s3_node_settings'),
        'settings': web_url_for('user_addons'),
    }
    if user_settings:
        result['owner'] = web_url_for('profile_view_id',
                                      uid=user_settings.owner._primary_key)
    return result
