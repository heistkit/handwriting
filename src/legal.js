/**
 * legal.js — privacy policy, terms, and licence notices.
 *
 * Written as data so the same text renders in the app, exports into the zip,
 * and stays reviewable in one place.
 *
 * A note on tone. Most privacy policies are long because the product collects a
 * lot and the document has to account for all of it. This one is short because
 * the app genuinely collects nothing — there is no server to send anything to.
 * The temptation is to pad it out with reassuring boilerplate copied from
 * elsewhere; that would be worse than useless, because boilerplate describes
 * practices this app does not have and would make the document *inaccurate*.
 * Every clause below describes something that is actually true of the code in
 * this repository, and can be verified by reading it or by watching the network
 * tab, which stays empty.
 */

/** Bump when the substance changes, not for typos. Shown to the user. */
export const LEGAL_VERSION = '1.0';
export const LEGAL_UPDATED = '2026-07-27';

export const PRIVACY = {
  id: 'privacy',
  title: 'Privacy',
  summary:
    'Nothing you write, photograph, or make is sent anywhere. There is no server to send it to.',
  sections: [
    {
      heading: 'What is collected',
      body: [
        'Nothing. No account, no email address, no name, no analytics, no cookies, no local storage, no fingerprinting, no error reporting, and no telemetry of any kind.',
        'There is no backend. Once this page has loaded, it makes no further network requests — you can disconnect from the internet entirely and every feature still works.',
      ],
    },
    {
      heading: 'What happens to your photographs',
      body: [
        'Your images are read directly by the browser and processed in memory on your own device. They are never transmitted, and they are never written to disk by this app.',
        'When you close or reload the tab, they are gone. Nothing persists between visits.',
      ],
    },
    {
      heading: 'What happens to the font you make',
      body: [
        'It is assembled in memory on your device and handed to your browser as a download. No copy is kept, and no copy is sent anywhere.',
        'The live preview uses an in-memory font that exists only while the tab is open.',
      ],
    },
    {
      heading: 'Third parties',
      body: [
        'None are contacted. The typeface used by the interface is served from this same site rather than from a font CDN, specifically so that loading the page does not disclose your visit to anyone else.',
        'The one exception is entirely under your control: if you choose to send feedback, a GitHub page opens with a report you have already read and can edit. Nothing is sent unless you post it yourself. GitHub\'s own privacy policy applies from that point.',
      ],
    },
    {
      heading: 'Hosting',
      body: [
        'This site is served as static files. The host may keep standard server logs, which typically include IP addresses and are outside this app\'s control — the same as for any website you visit. No such data is used by, or made available to, this app.',
      ],
    },
    {
      heading: 'Your rights',
      body: [
        'Rights to access, correct, export, or delete personal data generally presuppose that an operator holds some. This app holds none, so there is nothing to request and no request that could be fulfilled — deleting your data means closing the tab.',
      ],
    },
  ],
};

export const TERMS = {
  id: 'terms',
  title: 'Terms of use',
  summary:
    'Use it for anything. The fonts you make are entirely yours. It is provided as-is, with no warranty.',
  sections: [
    {
      heading: 'What you may do',
      body: [
        'Use this app for any purpose, personal or commercial, with no fee, no registration, and no limit on how many fonts you make.',
      ],
    },
    {
      heading: 'Who owns the font you make',
      body: [
        'You do, completely and exclusively. Fonts produced by this app carry no licence obligation, no attribution requirement, and no restriction of any kind.',
        'You may use them commercially, embed them in products, redistribute them, or sell them. No claim is made to them by this app, its author, or anyone else.',
      ],
    },
    {
      heading: 'Write only what is yours to write',
      body: [
        'You are responsible for what you feed into the app. Do not use it to reproduce a typeface you do not have the right to reproduce, or to imitate someone else\'s handwriting in order to deceive.',
        'Handwriting can be treated as personal data, and in some places a signature has specific legal weight. Making a font of another person\'s hand without their agreement may be unlawful where you live.',
      ],
    },
    {
      heading: 'No warranty',
      body: [
        'This app is provided "as is", without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, and non-infringement.',
        'In no event shall the authors or copyright holders be liable for any claim, damages, or other liability arising from the use of this software.',
        'It runs entirely on your device and cannot reach your files unless you select them, but no software is free of defects. Keep your original photographs until you are satisfied with the result.',
      ],
    },
    {
      heading: 'Changes',
      body: [
        'These terms may change. Because the app keeps no record of you, you will not be notified — the version and date shown here will simply differ.',
      ],
    },
  ],
};

export const LICENSES = {
  id: 'licenses',
  title: 'Licences',
  summary: 'The code is MIT. Two open-source components are included.',
  sections: [
    {
      heading: 'This app',
      body: [
        'MIT Licence. You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies of the software, provided the copyright notice and this permission notice are included.',
        'Source: github.com/heistkit/handwriting',
      ],
    },
    {
      heading: 'opentype.js',
      body: [
        'MIT Licence. Copyright (c) Frederik De Bleser. Used to assemble the font binaries.',
      ],
    },
    {
      heading: 'Geist',
      body: [
        'SIL Open Font License 1.1. Copyright (c) Vercel. Used for the interface typeface, and self-hosted so that no external request is made.',
        'The OFL permits redistribution as part of a larger work. It applies to the interface font only, and has no bearing on fonts you create.',
      ],
    },
  ],
};

export const DOCUMENTS = [PRIVACY, TERMS, LICENSES];
export const documentById = (id) => DOCUMENTS.find((d) => d.id === id);

/** Plain-text rendering, for the README written into the exported zip. */
export function toPlainText(doc) {
  const lines = [doc.title.toUpperCase(), '='.repeat(doc.title.length), '', doc.summary, ''];
  for (const s of doc.sections) {
    lines.push('', s.heading, '-'.repeat(s.heading.length));
    for (const p of s.body) lines.push(wrap(p, 76));
  }
  lines.push('', `Version ${LEGAL_VERSION} — ${LEGAL_UPDATED}`);
  return lines.join('\n');
}

function wrap(text, width) {
  const words = text.split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      out.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) out.push(line.trim());
  return out.join('\n');
}
