/**
 * legal.js — privacy policy, terms of use, and licence notices.
 *
 * Held as data so the same text renders in the app, exports into the download
 * bundle, and stays reviewable in one place.
 *
 * A note on method. The temptation with legal pages is to paste in a policy
 * from a comparable product and trim it. That produces a document which is long
 * but *false*: it describes collection, retention, sharing and transfer
 * practices this app does not have, and a policy that overstates what you do is
 * a worse liability than a short one that is accurate.
 *
 * So every clause below was written against the actual behaviour of the code in
 * this repository, and each is verifiable — by reading the source, or by
 * opening the network tab and watching it stay empty after load. Where a term
 * exists only because a feature exists (the device rate limit and its
 * identifier, for instance), the clause names the file that implements it.
 */

/**
 * Operator details.
 *
 * ─── SET THESE BEFORE PUBLISHING ────────────────────────────────────────────
 * `jurisdiction` decides which courts hear a dispute and which law applies. It
 * should be where the operator is actually established. It is left generic
 * rather than guessed, because naming the wrong forum in a published document
 * is worse than naming none.
 */
export const OPERATOR = {
  name: 'the maintainers of Inkwell',
  repo: 'https://github.com/heistkit/handwriting',
  contact: 'https://github.com/heistkit/handwriting/issues',
  jurisdiction: null, // e.g. 'the Republic of Korea' — see note above
};

/** Bump when the substance changes, not for typos. Shown to the user. */
export const LEGAL_VERSION = '1.2';
export const LEGAL_UPDATED = '2026-07-27';

/** Kept in sync with ratelimit.js and middleware.js — see the Terms. */
export const LIMITS = {
  perDevicePerMinute: 60,
  perAddressPerMinute: 500,
};

export const PRIVACY = {
  id: 'privacy',
  title: 'Privacy',
  summary:
    'Nothing you write, photograph, or create is sent anywhere. There is no server to send it to. One small counter is stored on your device, and it is described in full below.',
  sections: [
    {
      heading: 'The short version',
      body: [
        'This app runs entirely inside your browser. It has no backend, no database, and no account system. Your photographs are read into memory on your own device, processed there, and discarded when you close the tab.',
        'There is no analytics package, no advertising network, no third-party script, and no error-reporting service. After the page has finished loading it makes no further network requests at all — you can disconnect from the internet and every remaining feature still works.',
      ],
    },
    {
      heading: 'Personal data collected',
      body: [
        'None. Specifically: no name, no email address, no postal address, no telephone number, no date of birth, no payment details, no account credentials, no contact list, no location, and no advertising identifier.',
        'No profile is built about you, and no automated decision-making or profiling within the meaning of Article 22 GDPR takes place.',
      ],
    },
    {
      heading: 'Your images and handwriting',
      body: [
        'When you select a photograph, the browser hands the file to the page as raw pixels. The image is decoded, corrected for lighting and rotation, segmented into characters, and traced into outlines — every one of these steps executes on your own processor.',
        'The image is never uploaded, never copied to disk by this app, and never retained. It exists only in the tab\'s memory, and is released when you navigate away, reload, or close the tab.',
        'Handwriting can constitute personal data, and in some contexts biometric data. That is precisely why the design keeps it local: the app is built so that this question never arises, because the data never leaves the machine it was created on.',
      ],
    },
    {
      heading: 'The font you create',
      body: [
        'It is assembled in memory and passed to your browser as a download, using the same mechanism as saving any other file. No copy is kept and no copy is transmitted.',
        'The live preview registers the font with the page temporarily so it can be rendered on screen. That registration is discarded with the tab and is not visible to any other site.',
      ],
    },
    {
      heading: 'Camera and file access',
      body: [
        'The app can only read a file that you explicitly choose through your operating system\'s file picker, or an image you capture when you deliberately open the camera. Browsers do not permit a page to read files otherwise, and this one requests no additional permissions.',
        'It does not request microphone, location, contacts, notification, clipboard-read, or background access. If your browser ever prompts for any of these on this site, something is wrong and you should decline.',
      ],
    },
    {
      heading: 'What is stored on your device',
      body: [
        'Two things, both in your browser\'s local storage, and nothing else. No session storage, no IndexedDB, no cookies.',
        `First, the rate limit described in the Terms. The app keeps a short random string and a list of recent timestamps, so it can tell how many fonts have been built in the last minute and hold you to ${LIMITS.perDevicePerMinute} per minute.`,
        'That random string is generated on your device by your browser\'s cryptographic random number generator. It is not derived from your hardware, your browser configuration, your network, or anything else about you — two people on identical machines get different values, and the same person gets a new one in a fresh browser profile. It cannot be used to recognise you on any other site, and it is never transmitted anywhere.',
        'Second, your choice of light or dark theme, if you make one. Until you touch the switch nothing is stored and the app simply follows your system setting.',
        'You can erase both at any time by clearing site data for this domain. Doing so resets the counter and returns the theme to following your system; there is no other effect.',
      ],
    },
    {
      heading: 'Cookies',
      body: [
        'None are set, by this app or by anyone else. There is no consent banner because there is nothing to consent to.',
      ],
    },
    {
      heading: 'Third parties',
      body: [
        'No third-party service is contacted. The interface typeface is served from this same domain rather than from a font CDN, specifically so that loading the page does not disclose your visit to another company.',
        'The one exception is entirely in your hands: if you choose to send feedback, a page opens on GitHub containing a report you have already read and can edit. Nothing is transmitted unless you post it yourself, and from that point GitHub\'s own privacy policy governs.',
      ],
    },
    {
      heading: 'Hosting and server logs',
      body: [
        'The site is served as static files by a hosting provider. Like any web host, that provider processes the network requests needed to deliver the page, and may retain standard operational logs which typically include IP addresses, timestamps and user-agent strings.',
        `A rate limit of ${LIMITS.perAddressPerMinute} page requests per minute per network address operates at that same layer, to keep the site available. It counts requests in a short rolling window and retains nothing beyond it — no log, no history, and no association with anything you do inside the app.`,
        'This processing is ordinary infrastructure operation, is not used to identify or track you, and produces no data that is available to the app or to its maintainers for any other purpose.',
      ],
    },
    {
      heading: 'Children',
      body: [
        'The app is safe for anyone to use and collects nothing from anyone, regardless of age. Because no personal data is gathered, no parental consent mechanism is required and none is provided.',
      ],
    },
    {
      heading: 'International transfers',
      body: [
        'None occur. Data cannot be transferred across a border if it is never transmitted in the first place. The site itself may be delivered to you from a server geographically near you, which is a property of content delivery, not of data collection.',
      ],
    },
    {
      heading: 'Security',
      body: [
        'The most effective security measure available to a product like this is not to hold the data at all, and that is the approach taken. There is no store to breach, no credential to leak, and no backup to misplace.',
        'The site is served over HTTPS, which protects the integrity of the code delivered to you.',
      ],
    },
    {
      heading: 'Your rights',
      body: [
        'Rights of access, rectification, erasure, restriction, portability, and objection all presuppose that an operator holds personal data about you. This one holds none, so there is no record to produce, correct, or delete.',
        'In practice: erasing your data means closing the tab. Erasing the rate-limit counter means clearing site data.',
        `If you believe this is inaccurate, the source code is public and you are welcome to inspect it or raise the issue at ${OPERATOR.contact}.`,
      ],
    },
    {
      heading: 'Changes to this policy',
      body: [
        'This policy may change if the app changes. Because no record of you is kept, there is no way to notify you — the version number and date shown at the foot of this document will simply differ, and the history of every change is public in the repository.',
      ],
    },
  ],
};

export const TERMS = {
  id: 'terms',
  title: 'Terms of use',
  summary:
    'Free for any purpose, commercial included. The fonts you make are entirely yours, with no attribution required. Provided as-is, with no warranty.',
  sections: [
    {
      heading: 'Agreement',
      body: [
        'By using this app you accept these terms. If you do not accept them, do not use it. No account or signature is involved; use is the acceptance.',
      ],
    },
    {
      heading: 'What you may do',
      body: [
        'Use this app for any purpose, personal or commercial, at no cost, without registering, and without any limit on the number of fonts you create.',
        'No licence key, no watermark, no trial period, and no paid tier exists or is contemplated by these terms.',
      ],
    },
    {
      heading: 'Ownership of the fonts you create',
      body: [
        'You own them outright and exclusively. A font produced by this app carries no licence obligation, no attribution requirement, no field-of-use restriction, and no royalty.',
        'You may use it commercially, embed it in an application or document, install it on any number of machines, redistribute it, modify it, or sell it. Neither this app, its maintainers, nor any contributor asserts any claim over it.',
        'This is possible because the font contains only your own handwriting. No part of any third-party typeface is copied into your output — the software that assembles the file is licensed separately, and its licence does not reach the file it produces.',
      ],
    },
    {
      heading: 'Write only what is yours to write',
      body: [
        'You are responsible for the material you supply. Do not use this app to reproduce a typeface you have no right to reproduce, or to imitate another person\'s handwriting in order to deceive.',
        'A handwritten signature carries specific legal weight in many places, and reproducing one to execute a document you are not authorised to execute is forgery regardless of the tool involved.',
        'Handwriting may also be treated as personal data. Creating a font from another person\'s hand without their agreement may be unlawful where you or they live, even if your intentions are benign.',
      ],
    },
    {
      heading: 'Prohibited uses',
      body: [
        'Do not use this app to commit fraud or forgery; to impersonate a person, business, or public authority; to infringe a copyright, trademark, or design right; to harass or defame; or in violation of any applicable law, sanctions regime, or export control.',
        'Do not attempt to interfere with the availability of the service for others, including by circumventing the rate limits described below.',
      ],
    },
    {
      heading: 'Rate limits',
      body: [
        `Two limits operate. Your browser may build up to ${LIMITS.perDevicePerMinute} fonts per minute, and any single network address may request up to ${LIMITS.perAddressPerMinute} pages per minute.`,
        'Both are set far above ordinary use — building a font takes minutes of writing and photographing, so the per-device limit is unreachable by hand. They exist to stop automated abuse from degrading the service, not to ration it.',
        'If you hit a limit, waiting briefly clears it. Nothing is lost: work already in progress is unaffected, and no penalty accrues.',
        'These limits may be adjusted without notice if abuse patterns require it.',
      ],
    },
    {
      heading: 'Availability',
      body: [
        'The app is offered without any guarantee of availability. It may be changed, interrupted, or withdrawn at any time and without notice.',
        'Because it runs entirely in your browser, a copy you have already loaded keeps working offline, and the source code is public — so withdrawal of the hosted version does not strand you.',
      ],
    },
    {
      heading: 'Disclaimer of warranty',
      body: [
        'This app is provided "as is" and "as available", without warranty of any kind, whether express, implied, or statutory. This includes, without limitation, the implied warranties of merchantability, fitness for a particular purpose, title, and non-infringement.',
        'No warranty is given that the app will be uninterrupted, error-free, or secure, that defects will be corrected, or that any font it produces will meet your requirements or function correctly in any particular application.',
        'It runs on your own device and cannot read your files unless you select them, but no software is free of defects. Keep your original photographs until you are satisfied with the result.',
      ],
    },
    {
      heading: 'Limitation of liability',
      body: [
        'To the fullest extent permitted by law, neither the maintainers nor any contributor shall be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, or for any loss of profits, revenue, data, goodwill, or business opportunity, arising out of or in connection with your use of or inability to use this app — whether based in contract, tort, negligence, strict liability, or any other theory, and even if advised of the possibility of such damages.',
        'To the fullest extent permitted by law, total aggregate liability arising out of or relating to these terms shall not exceed the amount you paid to use this app, which is zero.',
        'Some jurisdictions do not allow the exclusion of implied warranties or the limitation of liability for certain damages. Where that is so, the exclusions and limitations above apply only to the extent permitted, and nothing in these terms limits liability for death or personal injury caused by negligence, or for fraud.',
      ],
    },
    {
      heading: 'Indemnity',
      body: [
        'You agree to indemnify and hold harmless the maintainers and contributors from any claim or demand, including reasonable legal costs, arising out of your breach of these terms or your misuse of the app — in particular, any claim that material you supplied infringed the rights of another person.',
      ],
    },
    {
      heading: 'Severability and waiver',
      body: [
        'If any provision of these terms is held unenforceable, it shall be modified to the minimum extent necessary to make it enforceable, and the remaining provisions shall continue in full force.',
        'A failure to enforce any provision is not a waiver of the right to enforce it later.',
      ],
    },
    {
      heading: 'Governing law',
      body: [
        OPERATOR.jurisdiction
          ? `These terms are governed by the laws of ${OPERATOR.jurisdiction}, without regard to its conflict of law rules, and the courts of that jurisdiction shall have exclusive jurisdiction over any dispute.`
          : 'These terms are governed by the law of the place in which the maintainers are established. Nothing in this clause deprives a consumer of the protection of mandatory provisions of the law of their own country of residence.',
      ],
    },
    {
      heading: 'Entire agreement and changes',
      body: [
        'These terms, together with the Privacy and Licences documents, constitute the entire agreement between you and the maintainers concerning this app.',
        'They may change. Because the app keeps no record of you, you will not be notified individually — the version and date below will differ, and the full history of changes is public in the repository. Continued use after a change constitutes acceptance of it.',
      ],
    },
    {
      heading: 'Contact',
      body: [
        `Questions, corrections, and disputes about these terms can be raised at ${OPERATOR.contact}.`,
      ],
    },
  ],
};

const MIT_TEXT = [
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
  'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
];

export const LICENSES = {
  id: 'licenses',
  title: 'Licences',
  summary:
    'The app is MIT licensed. Two open-source components are bundled. None of this reaches the fonts you make — those are unencumbered.',
  sections: [
    {
      heading: 'Fonts you create are not covered',
      body: [
        'Before anything else: none of the licences on this page apply to the fonts this app produces. They contain your handwriting and nothing else, and they carry no obligations whatsoever. This page concerns the software only.',
      ],
    },
    {
      heading: 'Inkwell — MIT Licence',
      body: [`Copyright (c) 2026 ${OPERATOR.name}.`, ...MIT_TEXT, `Source: ${OPERATOR.repo}`],
    },
    {
      heading: 'opentype.js — MIT Licence',
      body: [
        'Copyright (c) 2020 Frederik De Bleser. Used to assemble and serialise the font binaries.',
        ...MIT_TEXT,
      ],
    },
    {
      heading: 'Geist and Geist Mono — SIL Open Font License 1.1',
      body: [
        'Copyright (c) 2023 Vercel, Inc. Used for the interface typeface, and self-hosted so that rendering this page discloses your visit to no one else.',
        'The OFL permits use, study, modification, and redistribution, including as part of a larger work such as this one, provided the fonts are not sold on their own and that any modified version is released under the same licence and not under the reserved font name.',
        'This applies to the interface font only. It has no bearing on the fonts you create, which are yours without condition.',
      ],
    },
    {
      heading: 'No other dependencies',
      body: [
        'There is no framework, no build toolchain in the shipped output, no analytics library, and no polyfill service. Everything else in this app was written for it.',
      ],
    },
  ],
};

export const DOCUMENTS = [PRIVACY, TERMS, LICENSES];
export const documentById = (id) => DOCUMENTS.find((d) => d.id === id);

/** Plain-text rendering, for the files written into the download bundle. */
export function toPlainText(doc) {
  const lines = [doc.title.toUpperCase(), '='.repeat(doc.title.length), '', wrap(doc.summary, 76), ''];
  for (const s of doc.sections) {
    lines.push('', s.heading, '-'.repeat(s.heading.length), '');
    for (const p of s.body) lines.push(wrap(p, 76), '');
  }
  lines.push(`Version ${LEGAL_VERSION} — last updated ${LEGAL_UPDATED}`, OPERATOR.repo);
  return lines.join('\n');
}

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if ((line + ' ' + w).trim().length > width) {
      out.push(line.trim());
      line = w;
    } else line += ' ' + w;
  }
  if (line.trim()) out.push(line.trim());
  return out.join('\n');
}
