from __future__ import annotations

from pathlib import Path

from .model import Project, Track, iter_track_notes


PPQ = 480


def export_midi(project: Project, path: Path) -> None:
    tracks = [render_meta_track(project)]
    tracks.extend(render_music_track(track) for track in project.tracks)

    header = b"MThd" + (6).to_bytes(4, "big")
    header += (1).to_bytes(2, "big")
    header += len(tracks).to_bytes(2, "big")
    header += PPQ.to_bytes(2, "big")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + b"".join(tracks))


def render_meta_track(project: Project) -> bytes:
    events: list[tuple[int, int, bytes]] = []
    order = 0

    def add(tick: int, payload: bytes) -> None:
        nonlocal order
        events.append((tick, order, payload))
        order += 1

    add(0, meta_payload(0x03, b"Markers / Tempo"))
    add(0, meta_payload(0x51, int(60_000_000 / project.bpm).to_bytes(3, "big")))
    numerator, denominator = parse_signature(project.time_signature)
    add(0, meta_payload(0x58, bytes([numerator, denominator.bit_length() - 1, 24, 8])))
    for marker in project.markers:
        add(position_to_tick(marker.bar, 1), meta_payload(0x06, marker.name.encode("utf-8")))
    return render_track(events)


def render_music_track(track: Track) -> bytes:
    events: list[tuple[int, int, bytes]] = []
    order = 0

    def add(tick: int, payload: bytes) -> None:
        nonlocal order
        events.append((tick, order, payload))
        order += 1

    channel = clamp7(track.channel) & 0x0F
    add(0, meta_payload(0x03, track.name.encode("utf-8")))
    add(0, bytes([0xB0 | channel, 7, clamp7(track.volume)]))
    add(0, bytes([0xB0 | channel, 10, clamp7(track.pan)]))
    if track.program is not None and track.kind != "drum":
        add(0, bytes([0xC0 | channel, clamp7(track.program)]))

    if not track.muted:
        for note in iter_track_notes(track):
            tick = position_to_tick(note.bar, note.beat)
            duration = max(1, round(note.duration * PPQ))
            pitch = clamp7(note.pitch)
            add(tick, bytes([0x90 | channel, pitch, clamp7(note.velocity)]))
            add(tick + duration, bytes([0x80 | channel, pitch, 0]))

    return render_track(events)


def render_track(events: list[tuple[int, int, bytes]]) -> bytes:
    body = bytearray()
    last_tick = 0
    for tick, _order, payload in sorted(events):
        body.extend(vlq(tick - last_tick))
        body.extend(payload)
        last_tick = tick
    body.extend(vlq(0) + meta_payload(0x2F, b""))
    return b"MTrk" + len(body).to_bytes(4, "big") + body


def position_to_tick(bar: float, beat: float) -> int:
    return round(((bar - 1) * 4 + (beat - 1)) * PPQ)


def parse_signature(value: str) -> tuple[int, int]:
    numerator, denominator = value.split("/", 1)
    return int(numerator), int(denominator)


def meta_payload(kind: int, data: bytes) -> bytes:
    return bytes([0xFF, kind]) + vlq(len(data)) + data


def vlq(value: int) -> bytes:
    if value < 0:
        raise ValueError("VLQ value cannot be negative")
    buffer = value & 0x7F
    value >>= 7
    while value:
        buffer <<= 8
        buffer |= (value & 0x7F) | 0x80
        value >>= 7

    out = bytearray()
    while True:
        out.append(buffer & 0xFF)
        if buffer & 0x80:
            buffer >>= 8
        else:
            break
    return bytes(out)


def clamp7(value: int) -> int:
    return max(0, min(127, int(value)))
