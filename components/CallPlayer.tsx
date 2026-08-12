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

  const current = lines.reduce(
    (found, line, index) => (line.at <= at ? index : found),
    -1,
  );

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

  if (!src) {
    return (
      <div className="card blueprint player">
        <p className="text-muted empty-note">
          No recording for this call. Either recording is off for this
          restaurant, or the call ended before anyone picked up.
        </p>
      </div>
    );
  }

  return (
    <div className="card blueprint player">
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

      {lines.length > 0 ? (
        <div className="transcript">
          <h5>Transcript follows the audio</h5>
          <ol>
            {lines.map((line, index) => (
              <li
                key={`${line.at}-${index}`}
                className={index === current ? "line is-current" : "line"}
              >
                <button type="button" onClick={() => seek(line.at)}>
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
