import csv
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import analytics as module
import main


class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.journal = module.AnalyticsJournal(Path(self.tmp.name) / "activity.csv")

    def test_searches_cart_adds_and_approved_orders_are_distinct_and_idempotent(self):
        self.assertTrue(self.journal.record(event_id="search-001", kind="search", site="amazon.com", query="wool coat"))
        self.assertFalse(self.journal.record(event_id="search-001", kind="search", query="wool coat"))
        self.journal.record(event_id="search-002", kind="search", query="Wool Coat")
        self.journal.record(event_id="add-001", kind="cart_add", product_title="Wool Coat")
        self.journal.record(event_id="request-001", kind="add_request", product_title="Other Coat")
        order = {"id": "order-1", "created_at": "2026-09-27T12:00:00+00:00", "total_cents": 12900,
                 "items": [{"id": "j1", "title": "Wool Coat", "size": "M", "color": "Black",
                            "unit_price_cents": 12900}]}
        first = self.journal.summary([order])
        second = self.journal.summary([order])
        self.assertEqual(first, second)
        self.assertEqual(first["totals"], {"searches": 2, "confirmed_adds": 1,
                                          "add_requests": 1, "orders": 1,
                                          "items_purchased": 1, "demo_spend_cents": 12900})
        self.assertEqual(first["top_searches"][0]["count"], 2)
        self.assertEqual(first["top_purchased"][0]["label"], "Wool Coat")
        self.assertEqual(self.journal.interests()["searched"][0], "wool coat")
        with self.journal.path.open(newline="", encoding="utf-8") as file:
            self.assertEqual(len(list(csv.DictReader(file))), 5)

    def test_csv_values_cannot_become_spreadsheet_formulas(self):
        self.journal.record(event_id="search-001", kind="search", query=" =HYPERLINK(\"bad\")")
        self.assertTrue(self.journal.read()[0]["query"].startswith("'"))

    def test_api_rejects_other_websites_and_does_not_accept_purchase_events(self):
        client = TestClient(main.app)
        with patch.object(main, "analytics", self.journal), patch.object(main.checkout, "orders", return_value=[]):
            event = {"event_id": "search-001", "kind": "search", "query": "wool coat"}
            self.assertEqual(client.post("/api/analytics/event", json=event,
                                         headers={"Origin": "https://other-shop.example"}).status_code, 403)
            self.assertEqual(client.get("/api/analytics/summary",
                                        headers={"Origin": "https://other-shop.example"}).status_code, 403)
            self.assertEqual(client.post("/api/analytics/event", json={**event, "kind": "purchase"}).status_code, 422)
            self.assertEqual(client.post("/api/analytics/event", json=event).json(), {"recorded": True})
            self.assertEqual(client.get("/api/analytics/summary").json()["totals"]["searches"], 1)


if __name__ == "__main__":
    unittest.main()
