"""Local, append-only shopping activity for Cue's single-shopper demo.

Only explicit searches, cart actions, and approved demo orders are recorded.
Gaze samples, microphone audio, and general page visits never enter this file.
"""
from __future__ import annotations

import csv
import os
import threading
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path


FIELDS = ("timestamp", "event_id", "kind", "site", "query", "product_id",
          "product_title", "size", "color", "price_cents", "order_id")
DEFAULT_PATH = Path(__file__).resolve().parent / "data" / "shopping_analytics.csv"


def _text(value: object, limit: int = 200) -> str:
    value = " ".join(str(value or "").split())[:limit]
    # CSV is often opened in a spreadsheet. Keep user-supplied terms from
    # becoming formulas there, including ones hidden behind leading spaces.
    return "'" + value if value.lstrip().startswith(("=", "+", "-", "@")) else value


class AnalyticsJournal:
    def __init__(self, path: str | Path | None = None):
        self.path = Path(path or os.getenv("CUE_ANALYTICS_CSV") or DEFAULT_PATH)
        self._lock = threading.RLock()
        self._ids: set[str] | None = None

    def _read_unlocked(self) -> list[dict[str, str]]:
        if not self.path.exists():
            return []
        with self.path.open(newline="", encoding="utf-8") as file:
            return list(csv.DictReader(file))

    def read(self) -> list[dict[str, str]]:
        with self._lock:
            return self._read_unlocked()

    def ensure_file(self) -> Path:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if not self.path.exists():
                with self.path.open("w", newline="", encoding="utf-8") as file:
                    csv.writer(file).writerow(FIELDS)
            return self.path

    def record(self, *, event_id: str, kind: str, site: str = "", query: str = "",
               product_id: str = "", product_title: str = "", size: str = "",
               color: str = "", price_cents: int | None = None,
               order_id: str = "", timestamp: str | None = None) -> bool:
        if kind not in {"search", "cart_add", "add_request", "purchase"}:
            raise ValueError("Unknown analytics event")
        with self._lock:
            if self._ids is None:
                self._ids = {row["event_id"] for row in self._read_unlocked()}
            if event_id in self._ids:
                return False
            self.ensure_file()
            row = {
                "timestamp": timestamp or datetime.now(timezone.utc).isoformat(),
                "event_id": event_id,
                "kind": kind,
                "site": _text(site, 120),
                "query": _text(query, 120),
                "product_id": _text(product_id, 120),
                "product_title": _text(product_title, 200),
                "size": _text(size, 60),
                "color": _text(color, 60),
                "price_cents": "" if price_cents is None else str(int(price_cents)),
                "order_id": order_id,
            }
            with self.path.open("a", newline="", encoding="utf-8") as file:
                csv.DictWriter(file, fieldnames=FIELDS).writerow(row)
            self._ids.add(event_id)
            return True

    def sync_orders(self, orders: list[dict]) -> None:
        """Backfill successful checkouts if the process stopped before logging."""
        for order in orders:
            for index, item in enumerate(order.get("items", [])):
                self.record(
                    event_id=f"purchase:{order['id']}:{index}", kind="purchase",
                    site="Northfield demo", order_id=order["id"],
                    product_id=item.get("id", ""), product_title=item.get("title", ""),
                    size=item.get("size", ""), color=item.get("color", ""),
                    price_cents=item.get("unit_price_cents"),
                    timestamp=order.get("created_at"),
                )

    def summary(self, orders: list[dict]) -> dict:
        self.sync_orders(orders)
        rows = self.read()
        searches = [row for row in rows if row["kind"] == "search"]
        adds = [row for row in rows if row["kind"] == "cart_add"]
        requests = [row for row in rows if row["kind"] == "add_request"]
        purchases = [row for row in rows if row["kind"] == "purchase"]

        search_counts = Counter(row["query"].casefold() for row in searches if row["query"])
        search_labels = {row["query"].casefold(): row["query"] for row in searches if row["query"]}
        top_searches = [{"label": search_labels[key], "count": count}
                        for key, count in search_counts.most_common(6)]
        add_counts = Counter((row["product_title"], row["site"]) for row in adds if row["product_title"])
        top_added = [{"label": title, "site": site, "count": count}
                     for (title, site), count in add_counts.most_common(5)]
        purchase_counts = Counter(row["product_title"] for row in purchases if row["product_title"])
        top_purchased = [{"label": title, "count": count}
                         for title, count in purchase_counts.most_common(5)]

        today = datetime.now(timezone.utc).date()
        daily = []
        for days_ago in range(6, -1, -1):
            day = (today - timedelta(days=days_ago)).isoformat()
            daily.append({"date": day, "searches": sum(row["kind"] == "search" and
                           row["timestamp"][:10] == day for row in rows),
                          "adds": sum(row["kind"] == "cart_add" and
                           row["timestamp"][:10] == day for row in rows)})

        recent = []
        for row in sorted(rows, key=lambda item: item["timestamp"], reverse=True)[:12]:
            recent.append({"kind": row["kind"], "label": row["query"] if row["kind"] == "search"
                           else row["product_title"], "site": row["site"],
                           "at": row["timestamp"], "price_cents": int(row["price_cents"] or 0)})

        if top_searches and top_searches[0]["count"] >= 2:
            insight = {"title": "A recurring interest", "body":
                       f"You searched for {top_searches[0]['label']} {top_searches[0]['count']} times. "
                       "Cue can use that theme when you ask for ideas."}
        elif top_added:
            insight = {"title": "From interest to intent", "body":
                       f"{top_added[0]['label']} is the item you added most often while using Cue."}
        else:
            insight = {"title": "Your patterns will appear here", "body":
                       "Search and shop with Cue to see the interests you return to."}

        return {
            "totals": {"searches": len(searches), "confirmed_adds": len(adds),
                       "add_requests": len(requests), "orders": len(orders),
                       "items_purchased": len(purchases),
                       "demo_spend_cents": sum(int(order["total_cents"]) for order in orders)},
            "top_searches": top_searches,
            "top_added": top_added,
            "top_purchased": top_purchased,
            "daily": daily,
            "recent": recent,
            "insight": insight,
            "local": True,
        }

    def interests(self) -> dict:
        """A small, soft preference signal for conversational suggestions."""
        rows = self.read()
        counts = lambda kind, field: Counter(row[field] for row in rows
                                               if row["kind"] == kind and row[field])
        return {"searched": [name for name, _ in counts("search", "query").most_common(3)],
                "added": [name for name, _ in counts("cart_add", "product_title").most_common(3)],
                "purchased": [name for name, _ in counts("purchase", "product_title").most_common(3)]}
