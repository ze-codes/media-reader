# Third-Party Notices

Media Reader is distributed under the MIT License. Its direct JavaScript
dependencies and checked-in browser bundles retain their own licenses.

## Direct dependencies

| Package | Version in `bun.lock` | License | Copyright / project notice |
|---|---:|---|---|
| `busboy` | 1.6.0 | MIT | Copyright Brian White. All rights reserved. |
| `dompurify` | 3.3.1 | MPL-2.0 OR Apache-2.0 | Copyright 2025 Dr.-Ing. Mario Heiderich, Cure53 |
| `express` | 5.2.1 | MIT | Copyright 2009-2014 TJ Holowaychuk; 2013-2014 Roman Shtylman; 2014-2015 Douglas Christopher Wilson |
| `marked` | 17.0.1 | MIT | Copyright 2018+ MarkedJS; copyright 2011-2018 Christopher Jeffrey |

The exact license texts installed for these packages are in:

- `node_modules/busboy/LICENSE`
- `node_modules/dompurify/LICENSE`
- `node_modules/express/LICENSE`
- `node_modules/marked/LICENSE.md`

`marked`'s license file also contains the retained license notice for John
Gruber's Markdown. Transitive npm dependencies are recorded in `bun.lock` and
ship with their own package metadata and license files when installed.

## Direct development dependencies

| Package | Version in `bun.lock` | License | Project notice |
|---|---:|---|---|
| `playwright` | 1.62.0 | Apache-2.0 | Copyright Microsoft Corporation |

Playwright is used by the browser QA scripts and is not required by the
production server. Its installed license text is in
`node_modules/playwright/LICENSE`. Upstream source:
<https://github.com/microsoft/playwright>.

## Checked-in browser bundles

The following generated files are vendored so the reader UI does not require a
third-party CDN at runtime:

- `public/vendor/marked.umd.js` is Marked 17.0.1 under the MIT License. Its
  generated-file header and MarkedJS/Christopher Jeffrey copyright notices are
  preserved in the file.
- `public/vendor/purify.min.js` is DOMPurify 3.3.1 under MPL-2.0 OR Apache-2.0.
  Its upstream license header is preserved in the file.

Upstream project and license references:

- Marked: <https://github.com/markedjs/marked>
- DOMPurify: <https://github.com/cure53/DOMPurify>
- Mozilla Public License 2.0: <https://www.mozilla.org/MPL/2.0/>
- Apache License 2.0: <https://www.apache.org/licenses/LICENSE-2.0>

This notice is informational and does not replace the license text included by
each dependency or the license headers in the vendored files.
