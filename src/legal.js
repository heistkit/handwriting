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
  name: 'the maintainers of Handwrite',
  repo: 'https://github.com/heistkit/handwriting',
  contact: 'https://github.com/heistkit/handwriting/issues',
  jurisdiction: null, // e.g. 'the Republic of Korea' — see note above
};

/** Bump when the substance changes, not for typos. Shown to the user. */
export const LEGAL_VERSION = '2.1';
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
    'Nothing you write, photograph, or create is sent anywhere. There is no server to send it to. Seven small things are stored on your device — a counter, your five display settings, and a handful of stopwatch readings — and every one of them is described in full below.',
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
        'Seven things, all in your browser\'s local storage, and nothing else. No session storage, no IndexedDB, no cookies.',
        `First, the rate limit described in the Terms. The app keeps a short random string and a list of recent timestamps, so it can tell how many fonts have been built in the last minute and hold you to ${LIMITS.perDevicePerMinute} per minute.`,
        'That random string is generated on your device by your browser\'s cryptographic random number generator. It is not derived from your hardware, your browser configuration, your network, or anything else about you — two people on identical machines get different values, and the same person gets a new one in a fresh browser profile. It cannot be used to recognise you on any other site, and it is never transmitted anywhere.',
        'The next five are the settings you can see in the Settings panel: your choice of light or dark theme, whether lite mode is on, whether you have asked for larger text, whether panels fold open and shut, and whether the decorative movement runs. Each is written only once you have actually chosen it — and only the answer that differs from the default, so a switch you have never touched leaves nothing behind at all. Until then nothing is stored, and the app follows your system settings.',
        'Seventh, how long the last few operations took on this device. When you build a font the app times three things — reading a photograph, rebuilding the preview, and building all four styles — and keeps up to eight durations for each, oldest discarded. That is the whole record: at most twenty-four numbers, each one a count of milliseconds.',
        'It exists so that the estimate on screen has something to say in the first few seconds, before there is enough progress to measure the run in front of you. An estimate drawn from this history is labelled as such, so you always know whether you are reading a measurement or a memory.',
        'Durations only, deliberately. The obvious design also stores how much work each run covered — characters traced, cells on the sheet — which would make the estimate better and would also mean writing down how far through your own font you are. That is a fact about what you wrote, so it is not recorded. Nothing here is derived from your handwriting, your images, or the contents of your font.',
        'You can erase all seven at any time by clearing site data for this domain. Doing so resets the counter, returns the display settings to following your system, and forgets the timings; there is no other effect.',
      ],
    },
    {
      heading: 'Reading your device\'s capabilities',
      body: [
        'To estimate how long processing will take, and to decide whether to switch lite mode on by default, the app reads three things about the machine it is running on: the number of processor cores your browser reports, the rough amount of memory it reports, and how long a short calculation takes to run.',
        'These are read at the moment they are needed, used to produce a time estimate on screen, and discarded. None of the three is stored, combined into an identifier, or transmitted — there is no server to transmit to, and you can confirm the network stays silent.',
        'This is worth being precise about, because reading capability signals is also the raw material of device fingerprinting. The difference is what happens next: fingerprinting requires keeping the values and using them to recognise you again. These are neither kept nor associated with anything, and the app has no notion of a returning visitor to attach them to.',
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
        'The one exception is entirely in your hands: if you choose to send feedback, the report is copied to your clipboard and an empty issue form opens on GitHub. Nothing of yours reaches GitHub until you paste it in and post it, and from that point GitHub\'s own privacy policy governs. Opening that page is itself a visit to github.com, which their logs record as they would any other visit.',
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

/**
 * Numbered because a term you cannot cite is a term you cannot argue with.
 * Every clause has an address — "clause 11.2" — so a dispute, a correction or a
 * question can point at one sentence instead of at a page.
 *
 * Length here is not padding. Each article exists because something in the app
 * or in the law makes it necessary, and the ones that would be unenforceable in
 * some places say so rather than pretending otherwise. A term that overreaches
 * does not become stronger; it becomes severable.
 */
export const TERMS = {
  id: 'terms',
  title: 'Terms of use',
  summary:
    'Free for any purpose, commercial included. The fonts you make are entirely yours, with no attribution required. Provided as-is, with no warranty. You are responsible for what you write and what you do with it.',
  sections: [
    {
      heading: '1. Definitions',
      body: [
        '1.1 "App" means the Handwrite web application, comprising the pages, scripts, stylesheets, fonts and assets served from the domain at which you are reading this, together with any copy of them you have loaded into your browser.',
        '1.2 "Maintainers" means the persons identified in clause 22 who publish and maintain the App, and "we", "us" and "our" refer to them.',
        '1.3 "You" and "your" mean the individual or legal entity using the App. If you use the App on behalf of an organisation, you confirm you are authorised to bind that organisation, and "you" includes it.',
        '1.4 "Input" means any image, photograph, drawing, stroke, character, text or other material you supply to the App, whether by selecting a file, using a camera, or drawing in the App.',
        '1.5 "Output" means any font file, stylesheet snippet, archive, printable template or other artefact the App produces from your Input.',
        '1.6 "Device" means the computer, telephone, tablet or other equipment on which your browser runs the App.',
        '1.7 "Terms" means this document as it stands at the time you use the App, together with the Privacy and Licences documents, which are incorporated by reference.',
        '1.8 "Repository" means the public source repository identified in clause 22.2, which contains the complete source of the App and the full history of these Terms.',
        '1.9 Headings and article numbers are for navigation only and do not affect interpretation. The singular includes the plural. "Including" means "including without limitation", and no enumeration in these Terms is exhaustive unless it says so.',
      ],
    },
    {
      heading: '2. Acceptance, and how it happens',
      body: [
        '2.1 By using the App you accept these Terms. There is no button to press, no box to tick and no account to create: loading the App and using it is the acceptance.',
        '2.2 If you do not accept these Terms, your remedy is to stop using the App and close the page. Nothing is retained that would require any further step from you.',
        '2.3 You accept these Terms on your own behalf and on behalf of anyone you permit to use the App through your Device or your network connection. You are responsible for their use as if it were your own.',
        '2.4 You confirm that you are of an age at which you can form a binding contract where you live, or that you are using the App with the consent and under the supervision of a parent or guardian who accepts these Terms on your behalf.',
        '2.5 The App is not directed at children, does not knowingly collect anything from anyone of any age, and has no facility to do so — see the Privacy document.',
        '2.6 You confirm that you are not located in, and are not ordinarily resident in, any country or territory subject to comprehensive trade sanctions that would make the provision of the App to you unlawful, and that you do not appear on any restricted-party list that would have the same effect.',
      ],
    },
    {
      heading: '3. Licence to use the App',
      body: [
        '3.1 Subject to these Terms, you are granted a worldwide, royalty-free, non-exclusive, non-transferable licence to use the App for any purpose, personal or commercial.',
        '3.2 No fee is charged, no licence key exists, no watermark is applied, no trial period runs, and no paid tier exists or is contemplated by these Terms.',
        '3.3 There is no limit on the number of fonts you may create, other than the operational limits in article 7.',
        '3.4 The App itself is separately licensed under the MIT Licence, reproduced in the Licences document. Where clause 3.1 and the MIT Licence differ, the MIT Licence governs your rights in the App\'s source code, and these Terms govern your use of the hosted service.',
        '3.5 Nothing in these Terms transfers to you any trademark, service mark, trade name or logo of the Maintainers, and nothing here grants you the right to hold yourself out as affiliated with, endorsed by, or acting for them.',
      ],
    },
    {
      heading: '4. Your Input and your Output',
      body: [
        '4.1 You retain all rights in your Input. We claim none, receive none, and could not exercise any: the Input never leaves your Device, as described in the Privacy document.',
        '4.2 You own your Output outright and exclusively. It carries no licence obligation, no attribution requirement, no field-of-use restriction, no term limit and no royalty.',
        '4.3 You may use your Output commercially, embed it in an application, document or product, install it on any number of machines, redistribute it, modify it, sublicense it, or sell it, without seeking permission and without informing anyone.',
        '4.4 This is possible because the Output contains only your own handwriting. No part of any third-party typeface is copied into it. The software that assembles the file is licensed separately, and that licence does not reach the file it produces.',
        '4.5 We grant no warranty as to the originality of your Output, because originality depends entirely on what you wrote. Clause 5 addresses that.',
        '4.6 We have no copy of your Output and cannot recover it for you. If you lose it, it is gone, and the only remedy is to make it again.',
      ],
    },
    {
      heading: '5. Your responsibilities, and the limits of ours',
      body: [
        '5.1 You are solely responsible for your Input, for your Output, and for everything you do with either. We are not responsible for your actions, and this clause is intended to be read as broadly as the law allows.',
        '5.2 Without limiting clause 5.1, we are not responsible for: what you choose to write; whose handwriting you reproduce; what you make of the resulting font; where you install, publish, sell or distribute it; the consequences of any document you produce with it; or any decision anyone takes on the basis of something written in it.',
        '5.3 You warrant that you hold all rights necessary in your Input, and that neither your Input nor your use of your Output infringes any copyright, trademark, design right, database right, moral right, right of publicity, right of privacy, or any other right of any person.',
        '5.4 A handwritten signature carries specific legal weight in many places. Reproducing one in order to execute a document you are not authorised to execute is forgery, and the fact that a tool was involved changes nothing about that.',
        '5.5 Handwriting may constitute personal data, and in some contexts biometric data. Creating a font from another person\'s hand without their agreement may be unlawful where you or they live, however benign your intentions. Determining that is your responsibility, not ours.',
        '5.6 The App performs no review, moderation, filtering or verification of your Input, and is not capable of doing so: it has no server, sees nothing, and stores nothing. The absence of an objection from the App is not approval of anything.',
        '5.7 You are responsible for keeping your original photographs until you are satisfied with the Output, and for maintaining your own backups. The App keeps nothing.',
      ],
    },
    {
      heading: '6. Prohibited uses',
      body: [
        '6.1 You must not use the App to commit or facilitate fraud or forgery.',
        '6.2 You must not use the App to impersonate any person, business, institution or public authority, or to misrepresent your affiliation with any of them.',
        '6.3 You must not use the App to infringe any intellectual property right, including by reproducing a typeface you have no right to reproduce.',
        '6.4 You must not use the App to harass, threaten, defame, or facilitate violence against any person.',
        '6.5 You must not use the App in violation of any applicable law, regulation, sanctions regime or export control.',
        '6.6 You must not attempt to interfere with the availability of the App for others, including by circumventing, evading or automating around the limits in article 7.',
        '6.7 You must not misrepresent the App as your own product, or distribute a modified copy in a way that suggests the Maintainers endorse it.',
        '6.8 Clause 6.7 does not restrict any right the MIT Licence grants you in the source code; it restricts representation, not modification.',
      ],
    },
    {
      heading: '7. Operational limits',
      body: [
        `7.1 Two limits operate. Your browser may perform up to ${LIMITS.perDevicePerMinute} heavy operations per minute, and any single network address may request the page up to ${LIMITS.perAddressPerMinute} times per minute.`,
        '7.2 Both are set far above ordinary use. Building a font takes minutes of writing and photographing, so the per-device limit is not reachable by hand. They exist to stop automated abuse from degrading the service, not to ration it.',
        '7.3 If you reach a limit, waiting briefly clears it. Nothing is lost, work in progress is unaffected, and no penalty accrues.',
        '7.4 The per-device limit is enforced by code running in your own browser and is therefore trivially bypassable by anyone who wants to. We say so plainly rather than implying a protection that does not exist. Bypassing it is nonetheless a breach of clause 6.6.',
        '7.5 These limits may be adjusted at any time and without notice if abuse patterns require it.',
      ],
    },
    {
      heading: '8. Links to other sites',
      body: [
        '8.1 The App contains links to sites we do not operate, including the Repository and the sites of third-party licensors.',
        '8.2 Those sites are not under our control. We do not endorse them, are not responsible for their content, availability, accuracy, security or practices, and make no representation about them.',
        '8.3 Your use of any linked site is governed by that site\'s own terms and privacy policy, not by these Terms.',
        '8.4 Where the App warns you before following an external link, that warning is a courtesy and not a security guarantee. You remain responsible for deciding whether to proceed.',
      ],
    },
    {
      heading: '9. Availability, changes and withdrawal',
      body: [
        '9.1 The App is offered without any guarantee of availability. It may be changed, suspended, interrupted or withdrawn at any time, in whole or in part, without notice and without liability.',
        '9.2 No service level, uptime target or response time is promised, and none should be inferred from past availability.',
        '9.3 Features may be added, altered or removed. A feature present today is not promised tomorrow.',
        '9.4 Because the App runs entirely in your browser, a copy you have already loaded continues to work offline, and the complete source is public. Withdrawal of the hosted version therefore does not strand you: you may run your own copy under the MIT Licence.',
      ],
    },
    {
      heading: '10. Disclaimer of warranties',
      body: [
        '10.1 The App is provided "as is" and "as available", without warranty of any kind, whether express, implied or statutory.',
        '10.2 To the fullest extent permitted by law, we disclaim all implied warranties, including the implied warranties of merchantability, satisfactory quality, fitness for a particular purpose, title, accuracy, quiet enjoyment and non-infringement.',
        '10.3 We do not warrant that the App will be uninterrupted, timely, secure or error-free; that defects will be corrected; that the App or the server that delivers it is free of harmful components; or that any Output will meet your requirements or function correctly in any particular application, operating system or device.',
        '10.4 No advice or information, whether oral or written, obtained from us or through the App, creates any warranty not expressly stated in these Terms.',
        '10.5 The App runs on your own Device and cannot read your files unless you select them. No software is free of defects nonetheless.',
        '10.6 Some jurisdictions do not allow the exclusion of implied warranties. Where that is so, the exclusions in this article apply only to the extent permitted, and you may have rights that these Terms cannot reduce.',
      ],
    },
    {
      heading: '11. Limitation of liability',
      body: [
        '11.1 To the fullest extent permitted by law, neither the Maintainers nor any contributor shall be liable for any indirect, incidental, special, consequential, exemplary or punitive damages, or for any loss of profits, revenue, data, goodwill, business opportunity, or anticipated saving, arising out of or in connection with the App or these Terms.',
        '11.2 Clause 11.1 applies whether the claim is based in contract, tort, negligence, strict liability, statute or any other theory, and applies even if we have been advised of the possibility of such damages, and even if a limited remedy is found to have failed of its essential purpose.',
        '11.3 To the fullest extent permitted by law, our total aggregate liability arising out of or relating to the App and these Terms shall not exceed the greater of the total amount you have paid to use the App — which is zero — or ten units of your local currency.',
        '11.4 The limitations in this article are a fundamental basis of the bargain between us. The App is provided free of charge, and would not be provided at all on unlimited liability.',
        '11.5 Nothing in these Terms excludes or limits liability for death or personal injury caused by negligence, for fraud or fraudulent misrepresentation, or for any other liability that cannot lawfully be excluded or limited.',
        '11.6 Some jurisdictions do not allow the exclusion or limitation of certain damages. Where that is so, this article applies only to the extent permitted.',
      ],
    },
    {
      heading: '12. Indemnity',
      body: [
        '12.1 You agree to indemnify, defend and hold harmless the Maintainers and every contributor from and against any claim, demand, action, proceeding, loss, liability, damage, cost or expense, including reasonable legal fees, arising out of or relating to your Input, your Output, your use of the App, or your breach of these Terms.',
        '12.2 Clause 12.1 applies in particular to any claim that material you supplied infringed the rights of another person, or that something produced with the App was used to deceive.',
        '12.3 We reserve the right to assume the exclusive defence and control of any matter otherwise subject to indemnification by you, at your expense, and you agree to cooperate with that defence. You must not settle any matter affecting us without our prior written consent.',
        '12.4 This article survives any termination of these Terms.',
      ],
    },
    {
      heading: '13. Disputes, class actions and jury trial',
      body: [
        '13.1 Before commencing any proceeding, you agree to raise the matter with us informally at the address in clause 22.3 and to allow sixty days for it to be resolved. Most disagreements about free software are misunderstandings, and this costs nothing to try.',
        '13.2 To the fullest extent permitted by applicable law, you and we agree that each may bring claims against the other only in an individual capacity, and not as a plaintiff or class member in any purported class, collective, consolidated, coordinated, mass or representative proceeding.',
        '13.3 To the fullest extent permitted by applicable law, no arbitrator, judge or other adjudicator may consolidate the claims of more than one person, or otherwise preside over any form of representative or class proceeding arising out of these Terms.',
        '13.4 To the fullest extent permitted by applicable law, you and we each waive any right to a trial by jury in any proceeding arising out of or relating to these Terms or the App.',
        '13.5 Clauses 13.2 to 13.4 do not apply where they are prohibited or unenforceable under the law that governs your relationship with us. In particular, they do not apply to a consumer resident in the European Union or the United Kingdom to the extent that consumer protection law renders them ineffective, and they do not deprive anyone of a right to bring a claim before a competent public authority or of any non-waivable statutory right, including the right to bring a representative action where such a right exists by statute.',
        '13.6 If clause 13.2 is held unenforceable as to a particular claim, that claim shall be severed and heard in a court of competent jurisdiction, and the remainder of this article shall continue to apply to all other claims.',
        '13.7 Any claim arising out of or relating to the App must be brought within one year after the cause of action arises, or within the shortest period permitted by applicable law if that period is longer, failing which it is permanently barred — except where applicable law does not permit such a limitation.',
      ],
    },
    {
      heading: '14. Governing law and forum',
      body: [
        OPERATOR.jurisdiction
          ? `14.1 These Terms are governed by the laws of ${OPERATOR.jurisdiction}, without regard to its conflict of law rules.`
          : '14.1 These Terms are governed by the law of the place in which the Maintainers are established.',
        OPERATOR.jurisdiction
          ? `14.2 The courts of ${OPERATOR.jurisdiction} shall have jurisdiction over any dispute, subject to clause 14.3.`
          : '14.2 The courts of the place in which the Maintainers are established shall have jurisdiction over any dispute, subject to clause 14.3.',
        '14.3 Nothing in this article deprives a consumer of the protection of the mandatory provisions of the law of their own country of residence, nor of the right to bring proceedings in the courts of that country where applicable law gives them that right.',
        '14.4 The United Nations Convention on Contracts for the International Sale of Goods does not apply to these Terms.',
      ],
    },
    {
      heading: '15. Term, termination and survival',
      body: [
        '15.1 These Terms take effect when you first use the App and continue for as long as you use it.',
        '15.2 You may terminate at any time by ceasing to use the App. No notice is required and nothing needs to be deleted, because nothing about you is held.',
        '15.3 We may terminate or suspend your access at any time, for any reason or none, including where we consider that you have breached these Terms. In practice the only mechanism available to us is to withdraw the hosted App, since we have no account to close.',
        '15.4 Termination does not affect your Output. Fonts you have already created remain yours under article 4, permanently and unconditionally.',
        '15.5 Articles 1, 4, 5, 10, 11, 12, 13, 14, 15 and 20 survive termination.',
      ],
    },
    {
      heading: '16. Force majeure',
      body: [
        '16.1 We are not liable for any failure or delay caused by circumstances beyond our reasonable control, including acts of God, natural disaster, epidemic, war, terrorism, civil unrest, labour dispute, failure of a hosting provider, network or power failure, change of law, or governmental action.',
        '16.2 The App has no backend, so the practical scope of this article is limited to the delivery of the page itself. Once loaded, a copy in your browser is unaffected by any of the above.',
      ],
    },
    {
      heading: '17. Export control and sanctions',
      body: [
        '17.1 You must comply with all applicable export control and sanctions laws in your use of the App and in any redistribution of it or of your Output.',
        '17.2 You must not use the App in, or export it to, any territory where doing so would breach those laws, and you must not make it available to any person or entity on a restricted-party list.',
        '17.3 You are responsible for determining whether these restrictions apply to you.',
      ],
    },
    {
      heading: '18. Assignment',
      body: [
        '18.1 You may not assign or transfer these Terms, or any right or obligation under them, without our prior written consent. Any purported assignment in breach of this clause is void.',
        '18.2 We may assign these Terms in whole or in part to any successor in connection with a merger, acquisition, reorganisation or sale of assets, or to a subsequent maintainer of the App, without your consent and without notice.',
      ],
    },
    {
      heading: '19. Notices',
      body: [
        '19.1 Because the App holds no contact details for you, we cannot notify you individually of anything, and no clause of these Terms should be read as promising that we will.',
        '19.2 Notices from us are given by publishing them in the App or in the Repository. They take effect when published.',
        '19.3 Notices to us must be given at the address in clause 22.3 and take effect when received.',
      ],
    },
    {
      heading: '20. General',
      body: [
        '20.1 Severability. If any provision of these Terms is held invalid, illegal or unenforceable, it shall be modified to the minimum extent necessary to make it enforceable, or if that is not possible, severed. The remaining provisions continue in full force.',
        '20.2 Waiver. A failure or delay in enforcing any provision is not a waiver of the right to enforce it later. A waiver is effective only if given in writing and only for the instance given.',
        '20.3 Entire agreement. These Terms, together with the Privacy and Licences documents, constitute the entire agreement between you and us concerning the App, and supersede any prior understanding, representation or statement about it.',
        '20.4 No partnership. Nothing in these Terms creates any partnership, joint venture, agency, employment or fiduciary relationship between you and us.',
        '20.5 Third parties. Except for the Maintainers and contributors named as beneficiaries in articles 11 and 12, no person who is not a party to these Terms has any right to enforce any of them.',
        '20.6 Interpretation. These Terms are not to be construed against either party by reason of authorship. Where an English version and a translation differ, the English version governs.',
        '20.7 Cumulative remedies. The rights and remedies in these Terms are cumulative and additional to any provided by law.',
      ],
    },
    {
      heading: '21. Changes to these Terms',
      body: [
        '21.1 These Terms may change. The version number and date at the foot of this document identify the version in force.',
        '21.2 Because the App keeps no record of you, you will not be notified individually. This is a direct consequence of the privacy design, not an oversight.',
        '21.3 The full history of every change is public in the Repository, so you can see exactly what changed, when, and why.',
        '21.4 Continued use of the App after a change takes effect constitutes acceptance of the changed Terms. If you do not accept a change, stop using the App; your existing Output is unaffected in any event, under clause 15.4.',
      ],
    },
    {
      heading: '22. Contact and identification',
      body: [
        `22.1 The App is published and maintained by ${OPERATOR.name}.`,
        `22.2 The Repository is at ${OPERATOR.repo}.`,
        `22.3 Questions, corrections, complaints and notices, including the informal step required by clause 13.1, may be raised at ${OPERATOR.contact}.`,
        '22.4 If any statement in these Terms does not match what the code actually does, the code is the fact and the statement is the error. Report it at the address above and it will be corrected.',
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
    'The app is MIT licensed, and so is everything bundled into it. None of this reaches the fonts you make — those are unencumbered.',
  sections: [
    {
      heading: 'Fonts you create are not covered',
      body: [
        'Before anything else: none of the licences on this page apply to the fonts this app produces. They contain your handwriting and nothing else, and they carry no obligations whatsoever. This page concerns the software only.',
      ],
    },
    {
      heading: 'Handwrite — MIT Licence',
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
      heading: 'Interface components from Uiverse.io — MIT Licence',
      body: [
        'Twelve interface pieces began as components published on uiverse.io, all under the MIT Licence: the theme switch, the volume sliders and the copy button by Galahhad; the search field by Lakshay-art; the expanding call-to-action by cssbuttons-io; the download button by Na3ar-17; the envelope checkbox by SelfMadeSystem; the arc loader by mobinkakei; the letter wave by joao-canais; the progress bar by satyamchaudharydev; the skeleton placeholder by Nawsome; and the forward button by alexmaracinaru.',
        'Each was re-graded onto this palette and reworked for accessibility, so what ships is a modified version rather than the original. A comment above each block in the stylesheet names its author, and docs/COMPONENTS.md in the repository records every change made and why.',
        ...MIT_TEXT,
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
