from pathlib import Path
from http.server import ThreadingHTTPServer
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import json
import subprocess
import sys
import tempfile
import unittest
import wave

from chrodis.audio import export_wav
from chrodis.composer import compose_mandopop
from chrodis.effects import apply_effects
from chrodis.midi_import import import_midi
from chrodis.midi import export_midi
from chrodis.model import AudioClip, Clip, Effect, Marker, Note, Project, Track, iter_track_notes
from chrodis.patterns import add_pattern
from chrodis.project_io import migrate_project
from chrodis.synth import PresetLibrary, PresetResolver, load_preset_library_data
from chrodis.webgui import ChrodisHandler
import numpy as np


class ProjectModelTests(unittest.TestCase):
    def test_project_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "song.chrodis.json"
            project = Project(
                title="Song",
                bpm=119,
                key="C",
                markers=[Marker(bar=1, name="Intro")],
                tracks=[
                    Track(
                        name="Keys",
                        kind="instrument",
                        channel=0,
                        program=0,
                        preset="SYSTEM/钢琴/piano",
                        notes=[Note(1, 1, 60, 1, 90)],
                    )
                ],
            )

            project.save(path)
            loaded = Project.load(path)

            self.assertEqual(loaded.title, "Song")
            self.assertEqual(loaded.bpm, 119)
            self.assertEqual(loaded.markers[0].name, "Intro")
            self.assertEqual(loaded.tracks[0].preset, "SYSTEM/钢琴/piano")
            self.assertEqual(loaded.tracks[0].notes[0].pitch, 60)

    def test_project_folder_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "song.chrodis"
            project = Project(title="Folder Song")

            project.save(path)
            loaded = Project.load(path)

            self.assertEqual(loaded.title, "Folder Song")
            self.assertTrue((path / "project.json").exists())
            self.assertTrue((path / "exports").exists())

    def test_migrate_project_folder(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            old_path = Path(tmp) / "old.chrodis.json"
            new_path = Path(tmp) / "new.chrodis"
            Project(title="Old").save(old_path)

            migrated = migrate_project(old_path, new_path)

            self.assertEqual(migrated.title, "Old")
            self.assertEqual(Project.load(new_path).title, "Old")

    def test_old_project_without_preset_still_loads(self) -> None:
        project = Project.from_dict(
            {
                "title": "Old",
                "tracks": [
                    {
                        "name": "Keys",
                        "kind": "instrument",
                        "channel": 0,
                        "program": 0,
                        "notes": [],
                    }
                ],
            }
        )

        self.assertIsNone(project.tracks[0].preset)

    def test_preset_library_directory_contains_piano(self) -> None:
        resolver = PresetResolver(system_dir=Path("presets"))

        self.assertEqual(resolver.resolve("SYSTEM/钢琴/piano").name, "SYSTEM/钢琴/piano")

    def test_preset_resolver_uses_system_prefix(self) -> None:
        data = load_preset_library_data(Path("presets"))
        names = {item["name"] for item in data["presets"]}

        self.assertIn("SYSTEM/钢琴/piano", names)
        self.assertIn("SYSTEM/合成器/o3-lead", names)
        self.assertIn("SYSTEM/贝司/o3-bass", names)
        self.assertIn("SYSTEM/音垫/o3-pad", names)

    def test_project_round_trip_without_project_presets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "song.chrodis.json"
            project = Project(
                title="Song",
                tracks=[
                    Track(
                        name="Keys",
                        kind="instrument",
                        channel=0,
                        preset="SYSTEM/钢琴/piano",
                    )
                ],
            )

            project.save(path)
            loaded = Project.load(path)
            data = loaded.to_dict()

            self.assertEqual(loaded.tracks[0].preset, "SYSTEM/钢琴/piano")
            self.assertNotIn("project_presets", data)

    def test_resolver_resolves_project_preset_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            system_dir = Path("presets")
            project_presets_dir = Path(tmp) / "presets"
            project_presets_dir.mkdir()
            (project_presets_dir / "my-lead.json").write_text(
                json.dumps({"inherits": "SYSTEM/合成器/o3-lead", "output_gain": 0.44, "amp_envelope.sustain": 0.22}),
                encoding="utf-8",
            )
            resolver = PresetResolver(system_dir=system_dir, project_dir=project_presets_dir)
            preset = resolver.resolve("PROJECT/my-lead")
            base = resolver.resolve("SYSTEM/合成器/o3-lead")

            self.assertEqual(preset.data["synth_engine"], "o3")
            self.assertEqual(preset.data["output_gain"], 0.44)
            self.assertEqual(preset.data["amp_envelope"]["sustain"], 0.22)
            self.assertEqual(preset.data["amp_envelope"]["attack"], base.data["amp_envelope"]["attack"])

    def test_preset_library_normalizes_any_engine_to_o3(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            preset_dir = Path(tmp) / "presets" / "合成器"
            preset_dir.mkdir(parents=True)
            (preset_dir / "legacy.json").write_text(
                json.dumps({"display_name": "Legacy", "synth_engine": "anything"}),
                encoding="utf-8",
            )

            resolver = PresetResolver(system_dir=preset_dir.parent)

            self.assertEqual(resolver.resolve("SYSTEM/合成器/legacy").data["synth_engine"], "o3")

    def test_pattern_adds_notes(self) -> None:
        project = Project(title="Song", tracks=[Track(name="Drums", kind="drum", channel=9)])

        add_pattern(project, "Drums", "four-on-floor", 1, 2)

        self.assertGreater(len(project.find_track("Drums").notes), 0)

    def test_clip_notes_are_aggregated(self) -> None:
        track = Track(
            name="Keys",
            kind="instrument",
            channel=0,
            clips=[Clip(id="a", name="A", bar=5, beats=4, notes=[Note(1, 1, 60, 1, 90)])],
        )

        notes = iter_track_notes(track)

        self.assertEqual(notes[0].bar, 5)
        self.assertEqual(notes[0].beat, 1)

    def test_compose_mandopop_project_shape(self) -> None:
        project = compose_mandopop(minutes=3)

        self.assertEqual(project.length_bars, 72)
        self.assertGreaterEqual(len(project.tracks), 6)
        self.assertGreaterEqual(len(project.markers), 6)
        self.assertTrue(any(track.clips for track in project.tracks))
        self.assertTrue(project.master_effects)
        self.assertTrue(any(track.effects for track in project.tracks))

    def test_export_midi_writes_standard_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "song.mid"
            project = Project(
                title="Song",
                bpm=119,
                tracks=[Track(name="Keys", kind="instrument", channel=0, program=0, notes=[Note(1, 1, 60, 1, 90)])],
            )

            export_midi(project, path)
            data = path.read_bytes()

            self.assertTrue(data.startswith(b"MThd"))
            self.assertIn(b"MTrk", data)

    def test_export_midi_writes_clip_notes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "song.mid"
            project = Project(
                title="Song",
                tracks=[
                    Track(
                        name="Keys",
                        kind="instrument",
                        channel=0,
                        clips=[Clip(id="a", name="A", bar=1, beats=4, notes=[Note(1, 1, 60, 1, 90)])],
                    )
                ],
            )

            export_midi(project, path)

            self.assertIn(b"Keys", path.read_bytes())

    def test_export_wav_writes_stereo_pcm_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "song.wav"
            project = Project(
                title="Song",
                bpm=120,
                tracks=[
                    Track(
                        name="Keys",
                        kind="instrument",
                        channel=0,
                        program=0,
                        preset="SYSTEM/钢琴/piano",
                        notes=[Note(1, 1, 60, 1, 90)],
                    )
                ],
            )

            export_wav(project, path, sample_rate=8_000)

            with wave.open(str(path), "rb") as handle:
                self.assertEqual(handle.getnchannels(), 2)
                self.assertEqual(handle.getsampwidth(), 2)
                self.assertEqual(handle.getframerate(), 8_000)
                self.assertGreater(handle.getnframes(), 0)

    def test_effects_change_audio_without_clipping(self) -> None:
        buffer = np.ones((256, 2), dtype=np.float64) * 0.25
        processed = apply_effects(
            buffer,
            [Effect(type="delay", params={"time": 0.001, "feedback": 0.2, "mix": 0.5}), Effect(type="limiter", params={"ceiling_db": -1})],
            8_000,
        )

        self.assertEqual(processed.shape, buffer.shape)
        self.assertLessEqual(float(np.max(np.abs(processed))), 1.0)

    def test_import_midi_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            midi_path = Path(tmp) / "song.mid"
            original = Project(
                title="Song",
                tracks=[Track(name="Keys", kind="instrument", channel=0, program=0, notes=[Note(1, 1, 60, 1, 90)])],
            )
            export_midi(original, midi_path)

            imported = import_midi(midi_path, title="Imported")

            self.assertEqual(imported.title, "Imported")
            self.assertTrue(imported.tracks)
            self.assertTrue(imported.tracks[0].clips)

    def test_export_wav_missing_preset_has_clear_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "song.wav"
            project = Project(
                title="Song",
                tracks=[Track(name="Keys", kind="instrument", channel=0, preset="SYSTEM/missing", notes=[Note(1, 1, 60, 1, 90)])],
            )

            with self.assertRaises((KeyError, FileNotFoundError)):
                export_wav(project, path, sample_rate=8_000)


class CliTests(unittest.TestCase):
    def run_cli(self, *args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "chrodis.cli", *args],
            cwd=cwd,
            text=True,
            capture_output=True,
            check=True,
        )

    def test_cli_workflow(self) -> None:
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "song.chrodis.json"
            midi = Path(tmp) / "song.mid"

            self.run_cli("init", str(project), "--title", "Song", "--bpm", "119", cwd=repo)
            self.run_cli("add-track", str(project), "Keys", "--kind", "instrument", "--program", "0", "--preset", "SYSTEM/钢琴/piano", cwd=repo)
            self.run_cli("marker", str(project), "1", "Intro", cwd=repo)
            self.run_cli("note", str(project), "Keys", "--bar", "1", "--pitch", "60", cwd=repo)
            self.run_cli("pattern", str(project), "Keys", "piano-pulse", "--start-bar", "2", "--bars", "1", cwd=repo)
            self.run_cli("export-midi", str(project), str(midi), cwd=repo)

            self.assertTrue(midi.exists())
            self.assertTrue(midi.read_bytes().startswith(b"MThd"))
            self.assertEqual(Project.load(project).find_track("Keys").preset, "SYSTEM/钢琴/piano")

    def test_cli_export_wav(self) -> None:
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "song.chrodis.json"
            wav_path = Path(tmp) / "song.wav"

            self.run_cli("init", str(project), "--title", "Song", "--bpm", "120", cwd=repo)
            self.run_cli("add-track", str(project), "Keys", "--kind", "instrument", "--program", "0", "--preset", "SYSTEM/钢琴/piano", cwd=repo)
            self.run_cli("note", str(project), "Keys", "--bar", "1", "--pitch", "60", cwd=repo)
            self.run_cli(
                "export-wav",
                str(project),
                str(wav_path),
                "--sample-rate",
                "8000",
                "--preset-library",
                "presets",
                cwd=repo,
            )

            self.assertTrue(wav_path.exists())
            with wave.open(str(wav_path), "rb") as handle:
                self.assertEqual(handle.getnchannels(), 2)

    def test_cli_compose_mandopop(self) -> None:
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp) / "mandopop.chrodis.json"

            self.run_cli("compose", "mandopop", str(project_path), "--title", "晚风里的光", "--minutes", "3", cwd=repo)
            project = Project.load(project_path)

            self.assertEqual(project.title, "晚风里的光")
            self.assertEqual(project.length_bars, 72)

    def test_cli_import_midi_and_migrate(self) -> None:
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            midi_path = Path(tmp) / "song.mid"
            source = Project(title="Source", tracks=[Track(name="Keys", kind="instrument", channel=0, notes=[Note(1, 1, 60, 1, 90)])])
            export_midi(source, midi_path)
            imported_path = Path(tmp) / "imported.chrodis"
            migrated_path = Path(tmp) / "migrated.chrodis"

            self.run_cli("import-midi", str(midi_path), str(imported_path), "--title", "Imported", cwd=repo)
            self.run_cli("migrate", str(imported_path), str(migrated_path), cwd=repo)

            self.assertEqual(Project.load(migrated_path).title, "Imported")


class WebGuiTests(unittest.TestCase):
    def test_project_api_get_and_save(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp) / "song.chrodis.json"
            Project(title="Song").save(project_path)

            class Handler(ChrodisHandler):
                pass

            Handler.project_path = project_path
            try:
                server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            except PermissionError as exc:
                self.skipTest(f"local HTTP bind is not permitted in this environment: {exc}")
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with urlopen(base + "/api/project") as response:
                    data = json.loads(response.read().decode("utf-8"))
                self.assertEqual(data["title"], "Song")

                data["title"] = "Saved"
                request = Request(
                    base + "/api/project",
                    data=json.dumps(data).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(request) as response:
                    self.assertEqual(response.status, 200)
                self.assertEqual(Project.load(project_path).title, "Saved")
            finally:
                server.shutdown()
                server.server_close()

    def test_root_path_is_not_a_legacy_ui(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp) / "song.chrodis.json"
            Project(title="Song").save(project_path)

            class Handler(ChrodisHandler):
                pass

            Handler.project_path = project_path
            try:
                server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            except PermissionError as exc:
                self.skipTest(f"local HTTP bind is not permitted in this environment: {exc}")
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with self.assertRaises(HTTPError) as context:
                    urlopen(base + "/")
                self.assertEqual(context.exception.code, 404)
            finally:
                server.shutdown()
                server.server_close()

    def test_preset_api_returns_directory_presets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp) / "song.chrodis.json"
            Project(title="Song").save(project_path)

            class Handler(ChrodisHandler):
                pass

            Handler.project_path = project_path
            try:
                server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            except PermissionError as exc:
                self.skipTest(f"local HTTP bind is not permitted in this environment: {exc}")
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with urlopen(base + "/api/presets") as response:
                    data = json.loads(response.read().decode("utf-8"))
                self.assertTrue(any(item["name"] == "SYSTEM/钢琴/piano" for item in data["presets"]))
                self.assertFalse(any(item["name"].startswith("O3合成器/") for item in data["presets"]))
            finally:
                server.shutdown()
                server.server_close()

    def test_clip_patch_updates_notes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp) / "song.chrodis.json"
            Project(
                title="Song",
                tracks=[
                    Track(
                        name="Keys",
                        kind="instrument",
                        channel=0,
                        clips=[Clip(id="clip-a", name="A", bar=1, beats=4, notes=[Note(1, 1, 60, 1, 80)])],
                    )
                ],
            ).save(project_path)

            class Handler(ChrodisHandler):
                pass

            Handler.project_path = project_path
            try:
                server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            except PermissionError as exc:
                self.skipTest(f"local HTTP bind is not permitted in this environment: {exc}")
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                payload = {
                    "bar": 3,
                    "beats": 8,
                    "notes": [{"bar": 1, "beat": 2, "pitch": 67, "duration": 2, "velocity": 99}],
                }
                request = Request(
                    base + "/api/clip/0/clip-a",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="PATCH",
                )
                with urlopen(request) as response:
                    self.assertEqual(response.status, 200)
                clip = Project.load(project_path).tracks[0].clips[0]
                self.assertEqual(clip.bar, 3)
                self.assertEqual(clip.beats, 8)
                self.assertEqual(clip.notes[0].pitch, 67)
            finally:
                server.shutdown()
                server.server_close()

    def test_project_meta_patch_updates_editable_project_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp) / "song.chrodis.json"
            Project(title="Song", bpm=120, key="C", time_signature="4/4", length_bars=32).save(project_path)

            class Handler(ChrodisHandler):
                pass

            Handler.project_path = project_path
            try:
                server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            except PermissionError as exc:
                self.skipTest(f"local HTTP bind is not permitted in this environment: {exc}")
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                request = Request(
                    base + "/api/project/meta",
                    data=json.dumps({
                        "title": "Edited",
                        "bpm": 96,
                        "key": "G",
                        "time_signature": "3/4",
                        "length_bars": 24,
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="PATCH",
                )
                with urlopen(request) as response:
                    self.assertEqual(response.status, 200)
                project = Project.load(project_path)
                self.assertEqual(project.title, "Edited")
                self.assertEqual(project.bpm, 96)
                self.assertEqual(project.time_signature, "3/4")
                self.assertEqual(project.length_bars, 24)
            finally:
                server.shutdown()
                server.server_close()

    def test_audio_clip_patch_updates_audio_clip_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp) / "song.chrodis.json"
            Project(
                title="Song",
                tracks=[
                    Track(
                        name="Audio",
                        kind="audio",
                        channel=0,
                        audio_clips=[AudioClip(id="audio-a", name="Take", bar=1, beats=4, asset_path="assets/a.wav", duration_seconds=1, sample_rate=44100, channels=1)],
                    )
                ],
            ).save(project_path)

            class Handler(ChrodisHandler):
                pass

            Handler.project_path = project_path
            try:
                server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            except PermissionError as exc:
                self.skipTest(f"local HTTP bind is not permitted in this environment: {exc}")
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                request = Request(
                    base + "/api/clip/0/audio-a",
                    data=json.dumps({"name": "Edited Take", "bar": 3, "beats": 8, "gain": 0.5}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="PATCH",
                )
                with urlopen(request) as response:
                    self.assertEqual(response.status, 200)
                clip = Project.load(project_path).tracks[0].audio_clips[0]
                self.assertEqual(clip.name, "Edited Take")
                self.assertEqual(clip.bar, 3)
                self.assertEqual(clip.beats, 8)
                self.assertEqual(clip.gain, 0.5)
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
