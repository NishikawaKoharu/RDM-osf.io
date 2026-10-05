# -*- coding: utf-8 -*-
from __future__ import unicode_literals

from nose.tools import assert_equal, assert_false, assert_in, assert_not_in

from addons.wiki.sanitize import sanitize_wiki_markdown
from addons.wiki.tests.factories import WikiFactory, WikiVersionFactory
from osf_tests.factories import AuthUserFactory, ProjectFactory
from tests.base import OsfTestCase


class TestSanitizeWikiMarkdown(OsfTestCase):

    def test_keeps_toolbar_underline_and_color(self):
        content = 'Hello <u>under</u> and <span style="color: #ff0000">red</span>'
        out = sanitize_wiki_markdown(content)
        assert_in('<u>under</u>', out)
        assert_in('color: #ff0000', out)
        assert_in('>red</span>', out)

    def test_strips_embed_and_script(self):
        content = 'x<embed src="https://example.com/a">y<script>alert(1)</script>z'
        out = sanitize_wiki_markdown(content)
        assert_not_in('<embed', out)
        assert_not_in('<script', out)
        assert_in('x', out)
        assert_in('y', out)
        assert_in('z', out)

    def test_strips_position_style_keeps_color(self):
        content = '<span style="color: blue; position: fixed; z-index: 9">x</span>'
        out = sanitize_wiki_markdown(content)
        assert_in('color: blue', out)
        assert_not_in('position', out)
        assert_not_in('z-index', out)

    def test_rejects_javascript_markdown_link(self):
        content = 'click [here](javascript:alert(1)) please'
        out = sanitize_wiki_markdown(content)
        assert_not_in('javascript:', out)
        assert_in('here', out)
        assert_equal(out, 'click here please')

    def test_keeps_https_markdown_link_and_image(self):
        content = '[a](https://example.com/a) ![b](https://example.com/b.png)'
        assert_equal(sanitize_wiki_markdown(content), content)

    def test_preserves_code_and_math_with_less_than(self):
        content = 'inline `a < b` and $$a < b$$\n\n```\nx < y\n```'
        assert_equal(sanitize_wiki_markdown(content), content)

    def test_update_persists_sanitized_content(self):
        user = AuthUserFactory()
        project = ProjectFactory(creator=user)
        wiki_page = WikiFactory(user=user, node=project)
        WikiVersionFactory(user=user, wiki_page=wiki_page, content='safe')
        wiki_page.update(user, 'before <embed src="https://evil.example/x"> after')
        latest = wiki_page.get_version()
        assert_not_in('<embed', latest.content)
        assert_in('before', latest.content)
        assert_in('after', latest.content)
