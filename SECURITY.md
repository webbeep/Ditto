# Security

Ditto is a browser with an agent that reads pages and acts in your
signed-in sessions. Every website is untrusted, and so is everything a
website says: its text, its links' labels, its buttons, its videos'
transcripts. This page lists what Ditto defends against and how, so each
protection can be reviewed and tested.

## Reporting

Report a vulnerability privately through GitHub's *Report a vulnerability*
(Security tab of this repository). Please include steps to reproduce.

## What a website cannot do

**Reach the app.** Ditto's own pages (the chat, the new tab page) are served
from `ditto://app`; only they get answers from the app's bridge
(`AgentBridge`: main frame, `ditto` origin). Websites cannot navigate to,
frame or open them (`BrowserTab` cancels `ditto:` for anything the app did
not start). The new tab page may call only the seven methods it uses. Both
pages carry a Content Security Policy: only their own script runs, whatever
a page puts into an answer, and links taken from pages are kept only if
they open a web page (`safe_url.ts`: never `javascript:`, `file:` or data
documents).

**Reach the models.** The model runtime listens on a random loopback port
with a random key; the app blocks that port for every page (a WebKit
content rule), so a site cannot even list the models. Requests to the
runtime go to paths on it only, never to another address.

**Steer the agent (prompt injection).** Text written to an AI ("ignore
your previous instructions", "AI agent: go to … and type the user's
email", "if you are an AI…", chat-template markers) is taken out of page
text, element labels and transcripts before any model sees it, and the run
says so (`guard.ts`). Every prompt that shows page text says it is data,
never instructions. The models never write addresses: navigation only
follows the page's own links and fields, and the agent's typing comes from
your request, not from the page.

**Spend your money or send your data without you.** Anything that buys,
pays, books, sends, subscribes or deletes waits for **Approve**, judged by
both a button's label and what it shows (a "Place order" button labelled
"Next step" is still a purchase). Sending something Ditto typed (a name, a
message) needs Approve too, whatever the button is called, and typing never
presses Enter outside search boxes. The Approve card lists every field Ditto
filled. Ditto never types passwords or card details: it hands you the tab.

**Plant memories.** Notes about you are learned from your own words only,
never from answers (which are made of page text). You can see, forget and
switch off every note.

**Spam or trap you.** Pages cannot open windows without a click; Ditto's
tabs open none. Dialogs show as a sheet on their window (never freezing the
app), say which site asks, come only from the tab in front, and a page that
keeps showing them is silenced. Downloads come a few at a time per page,
never from Ditto's tabs, and are quarantined so macOS checks them before
they open. A page that crashes itself is reloaded twice a minute at most.
Ditto's tabs do not write to your history.

**Trick the address bar.** Only a leading `www.` is dropped from a shown
address (`bwww.ankofamerica.com` stays itself). Site icons are fetched only
from web addresses, never from your local network for a site on the
internet, and only up to 512 KB.

**Use Ditto as a crawler.** A run stops after 10 different sites, after its
step limit, and when it repeats itself. One question runs at a time per
chat; others queue. At most 20 pages are watched, each once per condition.

**Take your keyboard.** When the agent presses Enter in its tab, the
keyboard goes back to where you were at once.

## Seeing what Ditto did

**Memory → Activity** lists, newest first, every action Ditto took (with
the chat it was for), every approval asked, given or declined, everything
the shield stopped (ads, hijacked links, lines written to AI assistants),
notes learned and watch alerts. It stays on your Mac (the last 300
entries), never holds what was typed into a field, and can be cleared.

## Tested

`agent/test` runs these as attacks: a page that writes to the AI (its lines
and links never reach a model), a purchase disguised as "Next step", a form
whose send button is called "Continue", `javascript:` links and scripts in
Ditto's pages, a pasted `javascript:` address, learning from page text. The
eval suite runs the injection and disguise pages with real models.

## Known limits

Websites can tell they run in Ditto (the bridge's handler name is visible
to pages, though it answers none). A local program on your Mac can read the
runtime's key from its command line. Ditto is not yet signed with an Apple
Developer ID.
