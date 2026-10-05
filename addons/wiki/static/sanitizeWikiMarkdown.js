'use strict';

/**
 * Client-side mirror of addons.wiki.sanitize.sanitize_wiki_markdown.
 * Keeps toolbar HTML (u, colored span, etc.) and drops dangerous tags / schemes.
 */

var ALLOWED_TAGS = {
    a: true,
    br: true,
    em: true,
    img: true,
    span: true,
    strong: true,
    u: true
};

var ALLOWED_ATTRS = {
    a: { href: true, title: true },
    img: { src: true, alt: true, title: true, width: true, height: true },
    span: { style: true }
};

var PLACEHOLDER_PREFIX = '{{WIKI_SANITIZE_PROTECTED_';
var PLACEHOLDER_SUFFIX = '}}';

function isSafeUrl(url) {
    if (!url) {
        return false;
    }
    url = String(url).trim();
    if (!url) {
        return false;
    }
    var lower = url.toLowerCase();
    if (lower.indexOf('#') === 0 || lower.indexOf('/') === 0 ||
        lower.indexOf('./') === 0 || lower.indexOf('../') === 0) {
        return true;
    }
    var schemeHost = url.split('/')[0];
    if (schemeHost.indexOf(':') !== -1) {
        return lower.indexOf('http://') === 0 || lower.indexOf('https://') === 0;
    }
    return true;
}

function sanitizeStyle(styleValue) {
    if (!styleValue) {
        return '';
    }
    var parts = String(styleValue).split(';');
    var kept = [];
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i].trim();
        if (!part) {
            continue;
        }
        var idx = part.indexOf(':');
        if (idx === -1) {
            continue;
        }
        var prop = part.slice(0, idx).trim().toLowerCase();
        var val = part.slice(idx + 1).trim();
        if (prop === 'color' && val && !/url\s*\(|expression\s*\(/i.test(val)) {
            kept.push('color: ' + val);
        }
    }
    return kept.join('; ');
}

function protectRegions(content) {
    var protectedChunks = [];
    function replacer(match) {
        var idx = protectedChunks.length;
        protectedChunks.push(match);
        return PLACEHOLDER_PREFIX + idx + PLACEHOLDER_SUFFIX;
    }
    content = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, replacer);
    content = content.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, replacer);
    content = content.replace(/`[^`\n]+`/g, replacer);
    return { content: content, protectedChunks: protectedChunks };
}

function restoreRegions(content, protectedChunks) {
    for (var i = 0; i < protectedChunks.length; i++) {
        content = content.split(PLACEHOLDER_PREFIX + i + PLACEHOLDER_SUFFIX).join(protectedChunks[i]);
    }
    return content;
}

function sanitizeHtmlFragment(html) {
    if (typeof document === 'undefined') {
        return html;
    }
    var template = document.createElement('template');
    // Wrap so multiple roots / text nodes are preserved.
    template.innerHTML = '<div id="wiki-sanitize-root">' + html + '</div>';
    var root = template.content.getElementById('wiki-sanitize-root');
    if (!root) {
        return '';
    }

    function walk(node) {
        var children = Array.prototype.slice.call(node.childNodes);
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.nodeType === 1) {
                var tag = child.tagName.toLowerCase();
                if (!ALLOWED_TAGS[tag]) {
                    // Keep text content, drop the element.
                    while (child.firstChild) {
                        node.insertBefore(child.firstChild, child);
                    }
                    node.removeChild(child);
                    continue;
                }
                var allowed = ALLOWED_ATTRS[tag] || {};
                var attrs = Array.prototype.slice.call(child.attributes);
                for (var a = 0; a < attrs.length; a++) {
                    var name = attrs[a].name.toLowerCase();
                    var value = attrs[a].value;
                    if (!allowed[name]) {
                        child.removeAttribute(attrs[a].name);
                        continue;
                    }
                    if ((name === 'href' || name === 'src') && !isSafeUrl(value)) {
                        child.removeAttribute(attrs[a].name);
                        continue;
                    }
                    if (name === 'style') {
                        var cleaned = sanitizeStyle(value);
                        if (cleaned) {
                            child.setAttribute('style', cleaned);
                        } else {
                            child.removeAttribute('style');
                        }
                    }
                }
                walk(child);
            }
        }
    }

    walk(root);
    return root.innerHTML;
}

function sanitizeMarkdownUrls(content) {
    return content.replace(
        /(!?)\[([^\]]*)\]\((?:<([^>\n]+)>|((?:[^()\s]|\([^)]*\))+))(?:\s+("(?:\\.|[^"])*"|'(?:\\.|[^'])*'))?\s*\)/g,
        function(match, bang, text, angledUrl, bareUrl, title) {
            var url = angledUrl != null ? angledUrl : bareUrl;
            if (!isSafeUrl(url)) {
                return text || '';
            }
            var titlePart = title ? ' ' + title : '';
            if (angledUrl != null) {
                return bang + '[' + text + '](<' + url + '>' + titlePart + ')';
            }
            return bang + '[' + text + '](' + url + titlePart + ')';
        }
    );
}

function sanitizeWikiMarkdown(content) {
    if (content === null || content === undefined) {
        return '';
    }
    content = String(content);
    if (!content) {
        return content;
    }
    var protected = protectRegions(content);
    content = sanitizeHtmlFragment(protected.content);
    content = sanitizeMarkdownUrls(content);
    content = restoreRegions(content, protected.protectedChunks);
    return content;
}

module.exports = {
    sanitizeWikiMarkdown: sanitizeWikiMarkdown,
    isSafeUrl: isSafeUrl
};
