from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import base64
import json
import os
import re
import uuid
import wave

from .audio import export_wav
from .composer import compose_mandopop
from .midi import export_midi
from .model import AudioClip, Clip, Note, Project, Track
from .patterns import add_pattern


def run_gui(project_path: Path, port: int = 8765) -> None:
    project_path.parent.mkdir(parents=True, exist_ok=True)
    if not project_path.exists():
        Project(title=project_path.stem).save(project_path)

    class Handler(ChrodisHandler):
        pass

    Handler.project_path = project_path
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    if not os.environ.get("CHRODIS_EMBEDDED_API"):
        print(f"Chrodis API: http://127.0.0.1:{port}")
    server.serve_forever()


class ChrodisHandler(BaseHTTPRequestHandler):
    project_path = Path("projects/song.chrodis.json")

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            self.send_error(404, "Chrodis UI is served by the Electron/Vite renderer")
        elif path == "/api/project":
            self.send_json(Project.load(self.project_path).to_dict())
        elif path == "/api/presets":
            self.send_json(json.loads(Path("presets/builtin.json").read_text(encoding="utf-8")))
        elif path.startswith("/assets/"):
            file_path = self.project_root() / path.lstrip("/")
            if file_path.exists():
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.end_headers()
                self.wfile.write(file_path.read_bytes())
            else:
                self.send_error(404)
        elif path.startswith("/exports/"):
            file_path = Path(path.lstrip("/"))
            if file_path.exists():
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.end_headers()
                self.wfile.write(file_path.read_bytes())
            else:
                self.send_error(404)
        else:
            self.send_error(404)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        data = self.read_json()
        project = Project.load(self.project_path)

        if path == "/api/project":
            Project.from_dict(data).save(self.project_path)
            self.send_json({"ok": True})
        elif path == "/api/project/new":
            title = str(data.get("title", "Untitled"))
            bpm = int(data.get("bpm", 120))
            key = str(data.get("key", "C"))
            time_signature = str(data.get("time_signature", "4/4"))
            length_bars = int(data.get("length_bars", 32))
            slug = slugify(str(data.get("slug") or title or "untitled"))
            new_path = Path("projects") / f"{slug}.chrodis"
            new_project = Project(title=title, bpm=bpm, key=key, time_signature=time_signature, length_bars=length_bars)
            new_project.save(new_path)
            type(self).project_path = new_path
            self.send_json({"ok": True, "path": str(new_path), "project": new_project.to_dict()})
        elif path == "/api/track":
            channel = data.get("channel")
            kind = data.get("kind", "instrument")
            project.tracks.append(
                Track(
                    name=data.get("name", "New Track"),
                    kind=kind,
                    channel=int(channel) if channel is not None else project.next_channel(kind),
                    program=data.get("program"),
                    preset=data.get("preset"),
                    volume=int(data.get("volume", 96)),
                    pan=int(data.get("pan", 64)),
                )
            )
            project.save(self.project_path)
            self.send_json(project.to_dict())
        elif path == "/api/assets/audio":
            asset = save_audio_asset(self.project_root(), data)
            self.send_json({"ok": True, **asset})
        elif path == "/api/audio-clip":
            track = project.tracks[int(data["track_index"])]
            clip = AudioClip(
                id=str(data.get("id", f"audio-{uuid.uuid4().hex[:10]}")),
                name=str(data.get("name", "Audio Recording")),
                bar=float(data.get("bar", 1)),
                beats=float(data.get("beats", 4)),
                color=str(data.get("color", "#2e7ccf")),
                asset_path=str(data["asset_path"]),
                duration_seconds=float(data.get("duration_seconds", 0.0)),
                sample_rate=int(data.get("sample_rate", 44_100)),
                channels=int(data.get("channels", 1)),
                gain=float(data.get("gain", 1.0)),
            )
            track.audio_clips.append(clip)
            project.save(self.project_path)
            self.send_json(project.to_dict())
        elif path == "/api/clip":
            track = project.tracks[int(data["track_index"])]
            if "pattern" in data:
                before = len(track.notes)
                add_pattern(project, track.name, data["pattern"], int(data.get("bar", 1)), int(data.get("bars", 4)))
                notes = track.notes[before:]
                track.notes = track.notes[:before]
            else:
                notes = [Note.from_dict(item) for item in data.get("notes", [])]
            track.clips.append(
                Clip(
                    id=data.get("id", f"clip-{len(track.clips) + 1}"),
                    name=data.get("name", "Clip"),
                    bar=float(data.get("bar", 1)),
                    beats=float(data.get("beats", int(data.get("bars", 4)) * 4)),
                    color=data.get("color", "#18a83a"),
                    notes=notes,
                )
            )
            project.save(self.project_path)
            self.send_json(project.to_dict())
        elif path == "/api/export-midi":
            output = Path(data.get("output", "exports/gui/export.mid"))
            export_midi(project, output)
            self.send_json({"ok": True, "path": str(output)})
        elif path == "/api/export-wav":
            output = Path(data.get("output", "exports/gui/export.wav"))
            export_wav(project, output)
            self.send_json({"ok": True, "path": str(output), "url": "/" + str(output)})
        elif path == "/api/compose/mandopop":
            composed = compose_mandopop(data.get("title", "晚风里的光"), float(data.get("minutes", 3)))
            composed.save(self.project_path)
            self.send_json(composed.to_dict())
        else:
            self.send_error(404)

    def do_PATCH(self) -> None:
        path = urlparse(self.path).path
        data = self.read_json()
        project = Project.load(self.project_path)
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "project"] and parts[2] == "meta":
            for key in ("title", "bpm", "key", "time_signature", "length_bars"):
                if key in data:
                    setattr(project, key, data[key])
            project.bpm = int(project.bpm)
            project.length_bars = int(project.length_bars)
            project.save(self.project_path)
            self.send_json(project.to_dict())
        elif len(parts) == 3 and parts[:2] == ["api", "track"]:
            track = project.tracks[int(parts[2])]
            for key in ("name", "kind", "channel", "preset", "program", "volume", "pan", "muted", "solo", "record_armed"):
                if key in data:
                    setattr(track, key, data[key])
            project.save(self.project_path)
            self.send_json(project.to_dict())
        elif len(parts) in (4, 5) and parts[:2] == ["api", "clip"]:
            track = project.tracks[int(parts[2])]
            clip_id = parts[3]
            clip = next((item for item in track.clips if item.id == clip_id), None)
            if clip is None:
                clip = next(item for item in track.audio_clips if item.id == clip_id)
            for key in ("name", "bar", "beats", "color", "loop_count"):
                if key in data:
                    setattr(clip, key, data[key])
            if "notes" in data:
                if hasattr(clip, "notes"):
                    clip.notes = [Note.from_dict(item) for item in data["notes"]]
            if "gain" in data and hasattr(clip, "gain"):
                clip.gain = float(data["gain"])
            project.save(self.project_path)
            self.send_json(project.to_dict())
        else:
            self.send_error(404)

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        project = Project.load(self.project_path)
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "track"]:
            del project.tracks[int(parts[2])]
            project.save(self.project_path)
            self.send_json(project.to_dict())
        elif len(parts) == 4 and parts[:2] == ["api", "clip"]:
            track = project.tracks[int(parts[2])]
            clip_id = parts[3]
            track.clips = [clip for clip in track.clips if clip.id != clip_id]
            track.audio_clips = [clip for clip in track.audio_clips if clip.id != clip_id]
            project.save(self.project_path)
            self.send_json(project.to_dict())
        else:
            self.send_error(404)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def send_json(self, data: dict) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_text(self, text: str, content_type: str) -> None:
        payload = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args) -> None:
        return

    def project_root(self) -> Path:
        if self.project_path.suffix == ".chrodis" or self.project_path.is_dir():
            return self.project_path
        if self.project_path.name == "project.json" and self.project_path.parent.suffix == ".chrodis":
            return self.project_path.parent
        return self.project_path.parent


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff_-]+", "-", value.strip()).strip("-").lower()
    return slug or "untitled"


def save_audio_asset(project_root: Path, data: dict) -> dict:
    raw = str(data["data"])
    if "," in raw and raw.startswith("data:"):
        raw = raw.split(",", 1)[1]
    payload = base64.b64decode(raw)
    recordings = project_root / "assets" / "recordings"
    recordings.mkdir(parents=True, exist_ok=True)
    filename = slugify(str(data.get("name", "recording"))) + f"-{uuid.uuid4().hex[:8]}.wav"
    path = recordings / filename
    path.write_bytes(payload)
    with wave.open(str(path), "rb") as handle:
        sample_rate = handle.getframerate()
        channels = handle.getnchannels()
        duration_seconds = handle.getnframes() / float(sample_rate)
    return {
        "asset_path": str(Path("assets") / "recordings" / filename),
        "duration_seconds": duration_seconds,
        "sample_rate": sample_rate,
        "channels": channels,
    }


INDEX_HTML = r"""<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>chrodis</title>
<style>
body{margin:0;background:#202020;color:#eee;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}
.top{height:66px;background:#8d8d8d;display:flex;align-items:center;gap:12px;padding:0 14px;color:#111}
button,input,select{border:1px solid #555;background:#3b3b3b;color:#eee;border-radius:5px;padding:7px 10px}
.display{background:#101626;color:#d7e6ff;border-radius:4px;padding:8px 22px;text-align:center;font-size:22px}
.app{display:grid;grid-template-columns:270px 1fr;height:calc(100vh - 66px)}
.inspector{background:#454545;border-right:1px solid #111;padding:12px;overflow:auto}
.main{display:grid;grid-template-columns:270px 1fr;overflow:hidden}
.tracks{background:#626262;border-right:1px solid #222;overflow:auto}
.timeline{position:relative;overflow:auto;background:#252525}
.ruler{height:34px;background:#b99b19;color:#111;display:flex;position:sticky;top:0;z-index:2}
.bar{min-width:92px;border-right:1px solid #111;padding:8px 0 0 6px;box-sizing:border-box}
.track{height:74px;border-bottom:1px solid #3d3d3d;display:grid;grid-template-columns:34px 1fr;align-items:center}
.track .num{text-align:center;color:#ddd}
.track h3{margin:0;font-size:15px}.controls{display:flex;gap:5px;align-items:center;margin-top:6px}
.pill{padding:2px 6px;background:#4b4b4b;border-radius:4px}
.lane{height:74px;border-bottom:1px solid #333;position:relative;background-image:linear-gradient(90deg,rgba(255,255,255,.1) 1px,transparent 1px);background-size:92px 100%}
.clip{position:absolute;top:10px;height:50px;border-radius:5px;background:#18a83a;border:1px solid #063b13;box-sizing:border-box;padding:7px;color:white;font-weight:600;overflow:hidden}
.notes{margin-top:9px;color:#c5ffd0;letter-spacing:3px;white-space:nowrap}
label{display:block;margin:10px 0 4px;color:#ddd}.row{display:flex;gap:8px;margin:8px 0}.row>*{flex:1}
audio{width:100%;margin-top:10px}
</style>
<body>
<div class="top">
  <button onclick="save()">保存</button><button onclick="compose()">华语流行 Demo</button>
  <button onclick="addTrack()">添加轨道</button><button onclick="addPattern()">添加片段</button>
  <button onclick="exportMidi()">导出 MIDI</button><button onclick="exportWav()">导出 WAV</button>
  <div class="display"><span id="pos">001 1</span></div><div id="tempo"></div>
</div>
<div class="app">
  <aside class="inspector"><h2 id="title">chrodis</h2><div id="inspector"></div><div id="player"></div></aside>
  <section class="main"><div class="tracks" id="tracks"></div><div class="timeline"><div class="ruler" id="ruler"></div><div id="lanes"></div></div></section>
</div>
<script>
let project=null, selected={type:'project'};
const px=92;
async function api(url,method='GET',body=null){const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):null});return r.json()}
async function load(){project=await api('/api/project'); render()}
function render(){document.getElementById('title').textContent=project.title;document.getElementById('tempo').textContent=`${project.bpm} BPM · ${project.time_signature} · ${project.key}`;renderRuler();renderTracks();renderInspector()}
function renderRuler(){let h='';for(let i=1;i<=project.length_bars;i+=2)h+=`<div class=bar>${i}</div>`;ruler.innerHTML=h}
function renderTracks(){tracks.innerHTML='';lanes.innerHTML='';project.tracks.forEach((t,i)=>{tracks.innerHTML+=`<div class=track onclick="selectTrack(${i})"><div class=num>${i+1}</div><div><h3>${t.name}</h3><div class=controls><span class=pill>${t.preset||t.kind}</span><span>M ${t.muted?'✓':''}</span><span>S ${t.solo?'✓':''}</span><span>vol ${t.volume}</span></div></div></div>`;let c=(t.clips||[]).map(cl=>`<div class=clip onclick="event.stopPropagation();selectClip(${i},'${cl.id}')" style="left:${(cl.bar-1)*px}px;width:${cl.beats/4*px}px;background:${cl.color}">${cl.name}<div class=notes>${'· '.repeat(Math.min(36,(cl.notes||[]).length))}</div></div>`).join('');lanes.innerHTML+=`<div class=lane>${c}</div>`})}
function renderInspector(){let el=document.getElementById('inspector');if(selected.type==='track'){let t=project.tracks[selected.index];el.innerHTML=`<h3>轨道</h3><label>名称</label><input id=n value="${t.name}"><label>Preset</label><input id=p value="${t.preset||''}"><div class=row><input id=v type=number value="${t.volume}"><input id=pan type=number value="${t.pan}"></div><div class=row><button onclick="patchTrack(${selected.index})">应用</button><button onclick="toggleMute(${selected.index})">Mute</button><button onclick="toggleSolo(${selected.index})">Solo</button></div>`}else if(selected.type==='clip'){let t=project.tracks[selected.track];let c=t.clips.find(x=>x.id===selected.id);el.innerHTML=`<h3>片段</h3><label>名称</label><input id=cn value="${c.name}"><div class=row><input id=cb type=number value="${c.bar}"><input id=cl type=number value="${c.beats}"></div><button onclick="patchClip()">应用</button>`}else el.innerHTML='<p>选择轨道或片段进行编辑。</p>'}
function selectTrack(i){selected={type:'track',index:i};renderInspector()} function selectClip(t,id){selected={type:'clip',track:t,id};renderInspector()}
async function patchTrack(i){await api('/api/track/'+i,'PATCH',{name:n.value,preset:p.value||null,volume:+v.value,pan:+pan.value});load()}
async function toggleMute(i){let t=project.tracks[i];await api('/api/track/'+i,'PATCH',{muted:!t.muted});load()} async function toggleSolo(i){let t=project.tracks[i];await api('/api/track/'+i,'PATCH',{solo:!t.solo});load()}
async function patchClip(){await api(`/api/clip/${selected.track}/${selected.id}/edit`,'PATCH',{name:cn.value,bar:+cb.value,beats:+cl.value});load()}
async function save(){await api('/api/project','POST',project);alert('saved')}
async function addTrack(){await api('/api/track','POST',{name:'New Piano',kind:'instrument',preset:'piano',program:0});load()}
async function addPattern(){let i=selected.type==='track'?selected.index:0;await api('/api/clip','POST',{track_index:i,name:'Pattern',pattern:'piano-pulse',bar:1,bars:4});load()}
async function compose(){project=await api('/api/compose/mandopop','POST',{title:'晚风里的光',minutes:3});render()}
async function exportMidi(){let r=await api('/api/export-midi','POST',{output:'exports/gui/export.mid'});alert(r.path)}
async function exportWav(){let r=await api('/api/export-wav','POST',{output:'exports/gui/export.wav'});player.innerHTML=`<audio controls src="${r.url}?t=${Date.now()}"></audio><p>${r.path}</p>`}
load()
</script>
</body></html>"""
