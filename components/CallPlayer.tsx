"use client";

import { useEffect, useRef, useState } from "react";
import { mmss } from "@/lib/format";
import type { TranscriptLine } from "@/lib/data";

export function CallPlayer({
  src,
  lines,
  durationSeconds,
}: {
  src: string | null;
  lines: TranscriptLine[];
  durationSeconds: number | null;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [duration, setDuration] = useState(durationSeconds ?? 0);
  const [rate, setRate] = useState(1);
  const [expired, setExpired] = useState(false);

  // The signed link lasts five minutes. Rather than let playback fail
  // with a bare media error, say what happened and offer a reload.
  useEffect(() => {
    if (!src) return;
    const timer = setTimeout(() => setExpired(true), 300_000);
    return () => clearTimeout(timer);
  }, [src]);

  /* Which line is being spoken RIGHT NOW -- so only ever a real answer
     when there is audio to be at a position in. Without it `at` is
     pinned at 0 and a line stamped 0.0s would wear the "playing now"
     highlight over silence. */
  const current = src
    ? lines.reduce((found, line, index) => (line.at <= at ? index : found), -1)
    : -1;

  const seek = (seconds: number) => {
    if (!audio.current) return;
    audio.current.currentTime = seconds;
    setAt(seconds);
  };

  const toggle = () => {
    if (!audio.current) return;
    if (audio.current.paused) void audio.current.play();
    else audio.current.pause();
  };

  const cycleRate = () => {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (audio.current) audio.current.playbackRate = next;
  };

  /* THE AUDIO AND THE TRANSCRIPT ARE TWO SEPARATE ANSWERS, and this used
     to return early on `!src` -- which threw the transcript away with
     the player. That is not a rare corner: when a restaurant has
     `recording_enabled` false the Vapi webhook skips storeRecording
     entirely and still writes `transcript` with transcript_status
     'ready', so every call at every restaurant that turned recording off
     rendered "No recording for this call." over a transcript that was
     sitting right there in the row. Recording off is a lawful setting,
     not a broken call.

     So the controls drop away and the words stay. */
  return (
    <div className="card blueprint player">
      {src ? (
        <>
          <audio
            ref={audio}
            src={src}
            preload="metadata"
            onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
            onDurationChange={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d)) setDuration(d);
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => setExpired(true)}
          />

          <div className="player-controls">
            <button
              type="button"
              className="btn btn-primary player-play"
              onClick={toggle}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? "❚❚" : "▶"}
            </button>

            <input
              className="player-scrub"
              type="range"
              min={0}
              max={Math.max(duration, 1)}
              step={0.1}
              value={at}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="Playback position"
            />

            <span className="player-time num">
              {mmss(at)} / {mmss(duration)}
            </span>

            <button type="button" className="btn btn-secondary player-rate" onClick={cycleRate}>
              {rate}×
            </button>

            <a className="btn btn-secondary" href={src} download>
              Download
            </a>
          </div>

          <p className="text-muted player-note">
            {expired
              ? "That playback link has expired. Reload the page for a fresh one."
              : "Signed link, expires in 5 minutes · the recording announcement was played"}
          </p>
        </>
      ) : (
        <p className="text-muted empty-note">
          No recording for this call. Either recording is off for this
          restaurant, or the call ended before anyone picked up.
        </p>
      )}

      {lines.length > 0 ? (
        <div className="transcript">
          {/* The heading is a claim about behaviour, so it only gets to
              make it when there is audio for the words to follow. */}
          <h5>{src ? "Transcript follows the audio" : "Transcript"}</h5>
          <ol>
            {lines.map((line, index) => (
              <li
                key={`${line.at}-${index}`}
                className={index === current ? "line is-current" : "line"}
              >
                {/* Still a <button>, disabled, rather than a <div>: the
                    whole of .transcript .line's styling hangs off the
                    button selector, and `disabled` is what takes a
                    control that cannot do anything out of the focus
                    order instead of leaving a dead press behind. */}
                <button
                  type="button"
                  onClick={() => seek(line.at)}
                  disabled={!src}
                  title={src ? undefined : "There is no recording to jump to"}
                >
                  <span className="at num">{mmss(line.at)}</span>
                  <span className={`who who-${line.who}`}>{line.who}</span>
                  <span className="said">{line.text}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="text-muted empty-note">
          No transcript yet. It appears once the call is processed.
        </p>
      )}
    </div>
  );
}
