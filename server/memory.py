"""One local shopper. Profile lasts across visits. Conversation lasts for the tab."""
import json
import os
import pathlib
import re
import sqlite3
import time
from contextlib import contextmanager

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOPPER = "local"

SIZES = {"extra small": "XS", "extra large": "XL", "small": "S", "medium": "M",
         "large": "L", "xs": "XS", "xl": "XL", "xxl": "XXL"}
COLORS = ("black", "white", "navy", "blue", "green", "red", "brown", "camel",
          "beige", "grey", "gray", "oat", "cream", "pink", "slate")


class ShopperMemory:
    def __init__(self, db_path=None):
        self.db_path = pathlib.Path(db_path or os.getenv("CUE_DB", ROOT / "server/data/cue.sqlite3"))
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self.db() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS shopper_profile (
                    id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS shopper_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL, role TEXT NOT NULL,
                    content TEXT NOT NULL, created_at REAL NOT NULL
                );
            """)

    @contextmanager
    def db(self):
        conn = sqlite3.connect(self.db_path, timeout=5, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def profile(self):
        with self.db() as conn:
            row = conn.execute("SELECT profile_json FROM shopper_profile WHERE id=?", (SHOPPER,)).fetchone()
        if not row:
            return {"sizes": [], "colors": [], "price": None, "notes": []}
        try:
            data = json.loads(row["profile_json"])
        except json.JSONDecodeError:
            data = {}
        data.setdefault("sizes", [])
        data.setdefault("colors", [])
        data.setdefault("notes", [])
        return data

    def history(self, session_id, limit=12):
        with self.db() as conn:
            rows = conn.execute("""SELECT role, content FROM shopper_messages
                WHERE session_id=? ORDER BY id DESC LIMIT ?""", (session_id or "visit", limit)).fetchall()
        return [{"role": r["role"], "content": r["content"][:500]} for r in reversed(rows)]

    def purchases(self, limit=5):
        with self.db() as conn:
            try:
                rows = conn.execute("""SELECT items_json, total_cents, created_at FROM orders
                    ORDER BY created_at DESC LIMIT ?""", (limit,)).fetchall()
            except sqlite3.OperationalError:
                return []
        out = []
        for row in rows:
            try:
                items = json.loads(row["items_json"])
            except json.JSONDecodeError:
                items = []
            titles = [i.get("title") for i in items if isinstance(i, dict) and i.get("title")]
            out.append({"items": titles[:4], "total_cents": row["total_cents"]})
        return out

    def prompt_block(self, session_id):
        profile = self.profile()
        return {"profile": profile, "purchases": self.purchases(), "history": self.history(session_id)}

    def note(self, session_id, user_text, reply):
        session = (session_id or "visit")[:80]
        say = (reply or {}).get("say") or ""
        now = time.time()
        with self.db() as conn:
            conn.execute("INSERT INTO shopper_messages (session_id, role, content, created_at) VALUES (?,?,?,?)",
                         (session, "user", (user_text or "")[:500], now))
            if say:
                conn.execute("INSERT INTO shopper_messages (session_id, role, content, created_at) VALUES (?,?,?,?)",
                             (session, "assistant", say[:500], now))
            conn.execute("DELETE FROM shopper_messages WHERE id NOT IN (SELECT id FROM shopper_messages ORDER BY id DESC LIMIT 80)")
        self._learn(user_text or "")

    def _learn(self, text):
        t = text.lower()
        profile = self.profile()
        for word, size in SIZES.items():
            if re.search(rf"\b{re.escape(word)}\b", t) and size not in profile["sizes"]:
                profile["sizes"].insert(0, size)
        profile["sizes"] = profile["sizes"][:4]
        for color in COLORS:
            if re.search(rf"\b{color}\b", t) and color.title() not in profile["colors"]:
                profile["colors"].insert(0, color.title())
        profile["colors"] = profile["colors"][:6]
        if re.search(r"\b(too expensive|cheaper|over budget|can't afford|cannot afford)\b", t):
            profile["price"] = "prefers lower prices"
        if re.search(r"\b(too small|runs small|size up)\b", t):
            self._note(profile, "Finds things run small")
        if re.search(r"\b(too big|runs large|size down)\b", t):
            self._note(profile, "Finds things run large")
        liked = re.search(r"\b(?:i like|i love|i prefer|always)\b.{0,60}", t)
        if liked:
            self._note(profile, liked.group(0)[:80])
        with self.db() as conn:
            conn.execute("""INSERT INTO shopper_profile (id, profile_json, updated_at) VALUES (?,?,?)
                ON CONFLICT(id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at""",
                         (SHOPPER, json.dumps(profile), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))

    @staticmethod
    def _note(profile, line):
        if line and line not in profile["notes"]:
            profile["notes"].insert(0, line)
        profile["notes"] = profile["notes"][:8]
