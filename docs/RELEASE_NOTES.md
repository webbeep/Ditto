## Install

1. Download **Ditto-mac-arm64.dmg** (Apple silicon) or **Ditto-mac-x64.dmg**
   (Intel), open it and drag **Ditto** to **Applications**. macOS 14 or
   later.
2. Ditto is not yet signed with an Apple Developer ID, so macOS refuses to
   open it the first time. Allow it once in **Terminal**:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Ditto.app && open /Applications/Ditto.app
   ```

## What this is

A native Mac browser on WebKit with a local browsing agent built in.

- **Window:** tabs, favourites and the address in a sidebar, the page in a
  card, Ditto on the right. ⌘T or ⌘L opens one field for addresses,
  questions, search, tabs, bookmarks and history.
- **Ditto (⌘J):** a decider model navigates, an LLM plans and answers with
  sources, all on your Mac. It reads the open page or video, remembers your
  preferences (you can see and delete every note), starts from your own
  bookmarks and history, and does tasks in your signed-in tabs: it never
  types passwords, and anything that buys, sends or deletes waits for your
  Approve.
- **Shield:** ad networks blocked, ad slots hidden, click traps disarmed,
  YouTube ads skipped as soon as they can be, ad-block walls left by the
  site's own way out.
- **From Chrome:** bookmarks, history and your Google account in one click.

## New in this release

- **Calmer design:** a short answer leads with its key fact, large (the
  price, the hours), with the sentence under it, instead of repeating it
  in a card; the page picture is smaller. The composer is just the field
  and one button (how Ditto works moved to Models, in words). Ditto's live
  preview shows while it works and goes when it is done; in the Ditto
  layout finished tabs are rows, not shrunken pages, and every Ditto row
  says what it is doing ("Browsing espn.com", "Done").
- **Many questions at once, reliably:** home cards clicked in a row each
  start a chat of their own and run side by side (a double click asks
  once). Switching between Browse and Ditto no longer blanks the chat or
  stalls the questions it is running, a new Ditto tab is no longer closed
  by another question finishing, and questions starting together share one
  model load.
- **Queue a question:** typing while a chat works queues it under the chat
  ("Next", removable) and asks it as a follow-up when the answer is in;
  Stop drops the queue.
- **Right fact first:** asked what something costs, the card leads with the
  price, not the weight the same sentence mentions; answers cite only the
  pages that name what was asked about.
- **Better answers on the live web:** a misspelled question ("nba
  scires") still finds the scoreboard: pages are matched with a typo
  forgiven. Scores, results and headlines are answered from the page that
  lists them (they have no single sentence to quote), as bullet points.
- **Answers about the question, not you:** neither the plan nor the
  answer sees the sites you use any more (they once made "The user often
  uses google.com…" the answer);
  search engines are not counted as your sites, and an answer about you to
  a question that is not is written again. The same page is not cited
  twice, and a search page is not cited beside the pages it led to.
- **Ad-block walls:** "Looks like you're using an ad blocker" walls are
  left by the site's own *Continue without supporting*, for you and for
  Ditto.
- **Ask from a new tab, get an answer page:** a question typed on the new
  tab page opens the Ditto layout, the answer leading with Ditto's tabs live
  beside it, instead of a side chat next to an empty page. Questions read
  as headings, answers below, at any window size (the app tells the chat
  its layout; before, narrower windows kept chat bubbles). Ditto loads its
  models while you type.
- **Live tiles show the whole page:** Ditto's tabs beside the chat show
  each page from its top left (tall tiles cropped the left edge), and are
  lighter to keep updated.
- **Links in answers work:** sources, list items and pictures open as tabs
  (they did nothing before); choosing a tab returns to Browse.
- **Follow-ups stay on topic:** a follow-up about something the last
  sources do not name (the Mini after the Pro) is looked up, not answered
  from them.

- **Set up for your Mac:** on first launch Ditto shows your Mac's chip,
  memory and free disk and the pair of models that suits it (bigger on
  16 GB+ Apple silicon, the smallest on Intel or a full disk), with one
  Download button. Nothing downloads until you choose; Ditto answers once
  its models are here.
- **Browse or Ditto:** a switch at the top right, always in the same place.
  *Browse*: the page leads, the chat beside it. *Ditto* (⇧⌘J): the chat
  leads, with Ditto's tabs live beside it.
- **Several questions at once:** each chat runs in its own Ditto tab, side
  by side; start another while one works. The sidebar lists Ditto's tabs.
- **Answers you can see:** key facts, a list to choose from, steps, or a
  comparison table, picked by the decision model and filled from what the
  page states (the LLM only for a list, steps or a table the page has no
  structure for), with a picture of the page and the sentence it came from
  marked.
- **Steadier navigation:** pages from your history are a starting point only
  when they name what you asked about; on a page that names what you asked
  about, a price, weight, opening hours, year or size is read straight off
  the page; the planner's goal names what to find, never a page (a small
  model wrote "… on the page at index.html" and the decider then passed the
  right page by).
- **Quieter YouTube:** ads that cannot be skipped yet are muted and
  covered; *Skip* is pressed as soon as it appears. More ad slots hidden.
- **Faster, steadier answers:** notes about you are learned only from what
  you say about yourself, after the answer; follow-ups no longer copy old
  citation markers; chats and notes stay in sync across windows.
- **Watches:** "tell me when this drops below $40": Ditto checks the page on
  a schedule, in its own tab, and notifies you. Listed in *Memory*.
