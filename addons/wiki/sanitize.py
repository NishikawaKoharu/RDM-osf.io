# -*- coding: utf-8 -*-
"""Sanitize wiki markdown so only toolbar-compatible HTML fragments remain."""
from __future__ import unicode_literals

import re

import bleach
from six import text_type

# Raw HTML that toolbar / Milkdown may embed in markdown.
ALLOWED_TAGS = [
    'a', 'br', 'em', 'img', 'span', 'strong', 'u',
]

ALLOWED_ATTRIBUTES = {
    'a': ['href', 'title'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    'span': ['style'],
}

ALLOWED_STYLES = ['color']

ALLOWED_PROTOCOLS = ['http', 'https']

# Protect regions that may contain "<" without being HTML.
_PROTECTED_PATTERNS = [
    # fenced code blocks
    re.compile(r'(```[\s\S]*?```|~~~[\s\S]*?~~~)', re.MULTILINE),
    # display / inline math (KaTeX)
    re.compile(r'(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)'),
    # inline code
    re.compile(r'(`[^`\n]+`)'),
]

# Destinations may use <url> or a bare URL with one level of (...).
_MD_LINK_RE = re.compile(
    r'(!?)\[([^\]]*)\]\('
    r'(?:'
    r'<([^>\n]+)>'
    r'|'
    r'((?:[^()\s]|\([^)]*\))+)'
    r')'
    r'(?:\s+("(?:\\.|[^"])*"|\'(?:\\.|[^\'])*\'))?'
    r'\s*\)'
)

_PLACEHOLDER_FMT = '{{{{WIKI_SANITIZE_PROTECTED_{0}}}}}'


def _is_safe_url(url):
    if url is None:
        return False
    url = text_type(url).strip()
    if not url:
        return False
    lower = url.lower()
    if lower.startswith(('#', '/', './', '../')):
        return True
    # Scheme present in first path segment
    scheme_host = url.split('/', 1)[0]
    if ':' in scheme_host:
        return lower.startswith('http://') or lower.startswith('https://')
    # Relative path / bare filename without scheme
    return True


def _protect_regions(content):
    protected = []

    def repl(match):
        idx = len(protected)
        protected.append(match.group(0))
        return _PLACEHOLDER_FMT.format(idx)

    for pattern in _PROTECTED_PATTERNS:
        content = pattern.sub(repl, content)
    return content, protected


def _restore_regions(content, protected):
    for idx, chunk in enumerate(protected):
        content = content.replace(_PLACEHOLDER_FMT.format(idx), chunk)
    return content


def _sanitize_markdown_urls(content):
    def repl(match):
        bang, text, angled_url, bare_url, title = match.groups()
        url = angled_url if angled_url is not None else bare_url
        if not _is_safe_url(url):
            # Drop dangerous destination; keep visible text.
            return text or ''
        title_part = ' {}'.format(title) if title else ''
        if angled_url is not None:
            return '{bang}[{text}](<{url}>{title})'.format(
                bang=bang,
                text=text,
                url=url,
                title=title_part,
            )
        return '{bang}[{text}]({url}{title})'.format(
            bang=bang,
            text=text,
            url=url,
            title=title_part,
        )

    return _MD_LINK_RE.sub(repl, content)


def sanitize_wiki_markdown(content):
    """Return markdown safe for storage and display.

    - Keeps normal markdown
    - Allows limited raw HTML used by the wiki toolbar (``<u>``, colored ``<span>``, etc.)
    - Strips/escapes other HTML (embed/object/script/...)
    - Rejects dangerous URL schemes in markdown links/images and HTML href/src
    """
    if content is None:
        return ''
    content = text_type(content)
    if not content:
        return content

    content, protected = _protect_regions(content)
    content = bleach.clean(
        content,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        styles=ALLOWED_STYLES,
        protocols=ALLOWED_PROTOCOLS,
        strip=True,
    )
    content = _sanitize_markdown_urls(content)
    content = _restore_regions(content, protected)
    return content
