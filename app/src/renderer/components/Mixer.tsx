import React from 'react';
import { type Project, type Track } from '../api';
import { PanKnob, VerticalFader } from './controls';

export function Mixer({ project, onPatchTrack, renderTrackIcon }: {
  project: Project;
  onPatchTrack: (index: number, patch: Partial<Track>) => void;
  renderTrackIcon: (track: Track) => React.ReactNode;
}) {
  return <div className="mixer">
    <div className="mixer-channels">
      {project.tracks.map((track, index) => (
        <MixerChannel key={index} track={track} onPatch={patch => onPatchTrack(index, patch)} renderTrackIcon={renderTrackIcon} />
      ))}
      <div className="mixer-channel master-channel">
        <div className="mixer-effects-slots" />
        <PanKnob value={64} onChange={() => {}} />
        <div className="fader-area"><VerticalFader value={100} onChange={() => {}} /></div>
        <div className="mixer-buttons" />
        <div className="mixer-name">Master</div>
      </div>
    </div>
  </div>;
}

function MixerChannel({ track, onPatch, renderTrackIcon }: {
  track: Track;
  onPatch: (patch: Partial<Track>) => void;
  renderTrackIcon: (track: Track) => React.ReactNode;
}) {
  return <div className={`mixer-channel${track.muted ? ' muted' : ''}${track.solo ? ' solo' : ''}`}>
    <div className="mixer-effects-slots">
      {track.effects.map((effect, i) => (
        <button key={i} className={`effect-slot${effect.enabled ? ' active' : ''}`} title={effect.type}
          onClick={() => onPatch({ effects: track.effects.map((e, j) => j === i ? { ...e, enabled: !e.enabled } : e) })}>
          {effect.type.slice(0, 4)}
        </button>
      ))}
    </div>
    <PanKnob value={track.pan} onChange={pan => onPatch({ pan })} />
    <div className="fader-area"><VerticalFader value={track.volume} onChange={volume => onPatch({ volume })} /></div>
    <div className="mixer-buttons">
      <button className={`mini${track.muted ? ' active' : ''}`} onClick={() => onPatch({ muted: !track.muted })}>M</button>
      <button className={`mini${track.solo ? ' active' : ''}`} onClick={() => onPatch({ solo: !track.solo })}>S</button>
      <button className={`mini record${track.record_armed ? ' active' : ''}`} onClick={() => onPatch({ record_armed: !track.record_armed })}>R</button>
    </div>
    {renderTrackIcon(track)}
    <div className="mixer-name" title={track.name}>{track.name}</div>
  </div>;
}
