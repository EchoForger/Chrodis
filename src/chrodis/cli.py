from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
from pathlib import Path

from .audio import export_wav
from .composer import compose_mandopop
from .midi_import import import_midi
from .midi import export_midi
from .model import Marker, Note, Project, Track, iter_track_notes
from .patterns import add_pattern
from .project_io import migrate_project
from .webgui import run_gui


PATTERNS = ["piano-pulse", "sub-bass", "four-on-floor", "pad", "lead-hook"]


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="chrodis", description="Headless Logic-like music project tool.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="create a project")
    init_parser.add_argument("project")
    init_parser.add_argument("--title", default="Untitled")
    init_parser.add_argument("--bpm", type=int, default=120)
    init_parser.add_argument("--key", default="C")
    init_parser.add_argument("--time-signature", default="4/4")

    info_parser = subparsers.add_parser("info", help="show project summary")
    info_parser.add_argument("project")

    track_parser = subparsers.add_parser("add-track", help="add a MIDI track")
    track_parser.add_argument("project")
    track_parser.add_argument("name")
    track_parser.add_argument("--kind", choices=["instrument", "drum"], default="instrument")
    track_parser.add_argument("--channel", type=int)
    track_parser.add_argument("--program", type=int)
    track_parser.add_argument("--preset")
    track_parser.add_argument("--volume", type=int, default=96)
    track_parser.add_argument("--pan", type=int, default=64)

    marker_parser = subparsers.add_parser("marker", help="add an arrangement marker")
    marker_parser.add_argument("project")
    marker_parser.add_argument("bar", type=float)
    marker_parser.add_argument("name")

    note_parser = subparsers.add_parser("note", help="add a MIDI note")
    note_parser.add_argument("project")
    note_parser.add_argument("track")
    note_parser.add_argument("--bar", type=float, required=True)
    note_parser.add_argument("--beat", type=float, default=1)
    note_parser.add_argument("--pitch", type=int, required=True)
    note_parser.add_argument("--duration", type=float, default=1)
    note_parser.add_argument("--velocity", type=int, default=80)

    pattern_parser = subparsers.add_parser("pattern", help="add a built-in pattern")
    pattern_parser.add_argument("project")
    pattern_parser.add_argument("track")
    pattern_parser.add_argument("pattern", choices=PATTERNS)
    pattern_parser.add_argument("--start-bar", type=int, default=1)
    pattern_parser.add_argument("--bars", type=int, default=4)

    export_parser = subparsers.add_parser("export-midi", help="export a standard MIDI file")
    export_parser.add_argument("project")
    export_parser.add_argument("output")

    wav_parser = subparsers.add_parser("export-wav", help="render a stereo WAV file with built-in synth voices")
    wav_parser.add_argument("project")
    wav_parser.add_argument("output")
    wav_parser.add_argument("--sample-rate", type=int, default=44_100)
    wav_parser.add_argument("--preset-library", default="presets/builtin.json")

    gui_parser = subparsers.add_parser("gui", help="start the local Web GUI")
    gui_parser.add_argument("project")
    gui_parser.add_argument("--port", type=int, default=8765)

    serve_parser = subparsers.add_parser("serve", help="start the local Python API server")
    serve_parser.add_argument("project")
    serve_parser.add_argument("--port", type=int, default=8765)

    migrate_parser = subparsers.add_parser("migrate", help="migrate an old json project to a .chrodis folder")
    migrate_parser.add_argument("old_project")
    migrate_parser.add_argument("new_project")

    import_parser = subparsers.add_parser("import-midi", help="import a standard MIDI file")
    import_parser.add_argument("midi_file")
    import_parser.add_argument("project")
    import_parser.add_argument("--title")
    import_parser.add_argument("--append", action="store_true")

    compose_parser = subparsers.add_parser("compose", help="generate a complete song project")
    compose_sub = compose_parser.add_subparsers(dest="style", required=True)
    mandopop_parser = compose_sub.add_parser("mandopop", help="generate a 3-minute Mandarin pop instrumental")
    mandopop_parser.add_argument("project")
    mandopop_parser.add_argument("--title", default="晚风里的光")
    mandopop_parser.add_argument("--minutes", type=float, default=3.0)

    args = parser.parse_args(argv)

    if args.command == "init":
        project = Project(title=args.title, bpm=args.bpm, key=args.key, time_signature=args.time_signature)
        project.save(Path(args.project))
        print(f"created {args.project}")
        return
    if args.command == "gui":
        start_electron_gui(Path(args.project), args.port)
        return
    if args.command == "serve":
        run_gui(Path(args.project), port=args.port)
        return
    if args.command == "migrate":
        migrate_project(Path(args.old_project), Path(args.new_project))
        print(f"migrated {args.old_project} -> {args.new_project}")
        return
    if args.command == "import-midi":
        imported = import_midi(Path(args.midi_file), title=args.title)
        project_path = Path(args.project)
        if args.append and project_path.exists():
            project = Project.load(project_path)
            project.tracks.extend(imported.tracks)
            project.length_bars = max(project.length_bars, imported.length_bars)
        else:
            project = imported
        project.save(project_path)
        print(f"imported {args.midi_file} -> {args.project}")
        return
    if args.command == "compose" and args.style == "mandopop":
        project = compose_mandopop(title=args.title, minutes=args.minutes)
        project.save(Path(args.project))
        print(f"composed {args.project}")
        return

    project_path = Path(args.project)
    project = Project.load(project_path)

    if args.command == "info":
        print(summarize(project))
    elif args.command == "add-track":
        channel = args.channel if args.channel is not None else project.next_channel(args.kind)
        project.tracks.append(
            Track(
                name=args.name,
                kind=args.kind,
                channel=channel,
                program=args.program,
                preset=args.preset,
                volume=args.volume,
                pan=args.pan,
            )
        )
        project.save(project_path)
        print(f"added track: {args.name}")
    elif args.command == "marker":
        project.markers.append(Marker(bar=args.bar, name=args.name))
        project.save(project_path)
        print(f"added marker: {args.name} @ bar {args.bar:g}")
    elif args.command == "note":
        project.find_track(args.track).notes.append(
            Note(bar=args.bar, beat=args.beat, pitch=args.pitch, duration=args.duration, velocity=args.velocity)
        )
        project.save(project_path)
        print(f"added note to {args.track}")
    elif args.command == "pattern":
        add_pattern(project, args.track, args.pattern, args.start_bar, args.bars)
        project.save(project_path)
        print(f"added {args.pattern} to {args.track}")
    elif args.command == "export-midi":
        export_midi(project, Path(args.output))
        print(f"exported {args.output}")
    elif args.command == "export-wav":
        export_wav(project, Path(args.output), sample_rate=args.sample_rate, preset_library_path=Path(args.preset_library))
        print(f"exported {args.output}")


def summarize(project: Project) -> str:
    lines = [f"{project.title}: {project.bpm} BPM, {project.key}, {project.time_signature}"]
    if project.markers:
        lines.append("Markers:")
        for marker in sorted(project.markers, key=lambda item: item.bar):
            lines.append(f"  bar {marker.bar:g}: {marker.name}")
    if project.tracks:
        lines.append("Tracks:")
        for track in project.tracks:
            program = "" if track.program is None else f", program {track.program}"
            preset = "" if track.preset is None else f", preset {track.preset}"
            lines.append(
                f"  {track.name}: {track.kind}, ch {track.channel + 1}, "
                f"vol {track.volume}, pan {track.pan}{program}{preset}, "
                f"{len(track.clips)} clips, {len(iter_track_notes(track))} notes"
            )
    return "\n".join(lines)


def start_electron_gui(project: Path, port: int) -> None:
    app_dir = Path("app")
    api_port = find_available_port(port)
    if api_port != port:
        print(f"Port {port} is busy; using {api_port} for the internal Chrodis service.", file=sys.stderr)
    if not app_dir.exists():
        run_gui(project, port=api_port)
        return
    command = ["npm", "--prefix", str(app_dir), "run", "dev", "--", "--project", str(project), "--port", str(api_port)]
    try:
        env = {**os.environ, "CHRODIS_API_PORT": str(api_port)}
        subprocess.run(command, check=True, env=env)
    except (FileNotFoundError, subprocess.CalledProcessError):
        print("Electron GUI could not start; falling back to Python API GUI.", file=sys.stderr)
        run_gui(project, port=api_port)


def find_available_port(preferred: int, attempts: int = 50) -> int:
    for candidate in range(preferred, preferred + attempts):
        if is_port_available(candidate):
            return candidate
    raise RuntimeError(f"No free local port found from {preferred} to {preferred + attempts - 1}")


def is_port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


if __name__ == "__main__":
    main()
