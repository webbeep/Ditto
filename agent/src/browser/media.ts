// Runs inside the page (serialized like collectSnapshot) and returns what a
// video says, for "tl;dr this video": the transcript where there is one,
// else the description. Self-contained and async.
//
// YouTube: the caption track the player lists; if its file needs a token
// only the player adds, the transcript panel YouTube shows under the video.
// Other sites: a <video> with a captions or subtitles track.

export interface MediaText {
  kind: 'transcript'|'description';
  title: string;
  text: string;
}

export async function collectMedia(maxText: number): Promise<MediaText|null> {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, maxText);
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const title = document.title.replace(/ - YouTube$/, '');

  interface Track {
    baseUrl: string;
    languageCode?: string;
    kind?: string;
  }
  interface PlayerResponse {
    captions?: {playerCaptionsTracklistRenderer?: {captionTracks?: Track[]}};
    videoDetails?: {shortDescription?: string};
  }

  if (/(^|\.)youtube\.com$/.test(location.hostname) &&
      /^\/(watch|shorts|live)/.test(location.pathname)) {
    // The player knows the current video even after in-page navigation;
    // ytInitialPlayerResponse only knows the first one.
    const player = document.querySelector<
        HTMLElement & {getPlayerResponse?: () => PlayerResponse}>('#movie_player');
    const response = player?.getPlayerResponse?.() ??
        (window as unknown as {ytInitialPlayerResponse?: PlayerResponse})
            .ytInitialPlayerResponse;
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const lang = (navigator.language || 'en').slice(0, 2);
    // Prefer captions written by people over automatic ones.
    const track = tracks.find(t => t.languageCode?.startsWith(lang) && t.kind !== 'asr') ??
        tracks.find(t => t.languageCode?.startsWith(lang)) ?? tracks[0];
    if (track) {
      try {
        const body = await (await fetch(`${track.baseUrl}&fmt=json3`)).text();
        const data = body ? JSON.parse(body) as
            {events?: Array<{segs?: Array<{utf8?: string}>}>} : {};
        const text = (data.events ?? [])
                         .map(e => (e.segs ?? []).map(s => s.utf8 ?? '').join(''))
                         .join(' ');
        if (text.trim().length > 40) {
          return {kind: 'transcript', title, text: squash(text)};
        }
      } catch {
        // Fall through to the transcript panel.
      }
    }
    const segments = () => Array.from(document.querySelectorAll<HTMLElement>(
        'ytd-transcript-segment-renderer .segment-text, ' +
        'transcript-segment-view-model .yt-core-attributed-string'));
    if (!segments().length) {
      document.querySelector<HTMLElement>('#description-inline-expander #expand')?.click();
      await sleep(200);
      document.querySelector<HTMLElement>(
          'ytd-video-description-transcript-section-renderer button')?.click();
      for (let i = 0; i < 25 && !segments().length; ++i) {
        await sleep(200);
      }
    }
    const lines = segments().map(el => el.innerText.trim()).filter(Boolean);
    if (lines.length) {
      return {kind: 'transcript', title, text: squash(lines.join(' '))};
    }
    const description = response?.videoDetails?.shortDescription ??
        document.querySelector<HTMLElement>('#description-inline-expander')?.innerText ?? '';
    if (description.trim()) {
      return {kind: 'description', title, text: squash(description)};
    }
    return null;
  }

  const track = document.querySelector<HTMLTrackElement>(
      'video track[kind=captions][src], video track[kind=subtitles][src]');
  if (track) {
    try {
      const vtt = await (await fetch(track.src)).text();
      // Drop the header, cue numbers and timings.
      const text = vtt.split(/\r?\n/)
                       .filter(line => line.trim() && !/^WEBVTT|^\d+$|-->/.test(line.trim()))
                       .join(' ');
      if (text.trim()) {
        return {kind: 'transcript', title, text: squash(text)};
      }
    } catch {
      return null;
    }
  }
  return null;
}
