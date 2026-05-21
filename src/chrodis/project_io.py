from __future__ import annotations

from pathlib import Path
import shutil

from .model import Project


PROJECT_FILE = "project.json"


def project_file(path: Path) -> Path:
    if path.suffix == ".chrodis" or path.is_dir():
        return path / PROJECT_FILE
    return path


def load_project(path: Path) -> Project:
    return Project.load(project_file(path))


def save_project(project: Project, path: Path) -> None:
    if path.suffix == ".chrodis" or path.is_dir():
        path.mkdir(parents=True, exist_ok=True)
        (path / "exports").mkdir(exist_ok=True)
        (path / "assets").mkdir(exist_ok=True)
    project.save(project_file(path))


def migrate_project(old_path: Path, new_path: Path) -> Project:
    project = load_project(old_path)
    save_project(project, new_path)
    return project


def default_export_path(project_path: Path, name: str) -> Path:
    if project_path.suffix == ".chrodis" or project_path.is_dir():
        return project_path / "exports" / name
    return Path("exports") / name
