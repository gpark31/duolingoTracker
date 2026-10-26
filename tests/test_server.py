import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

import server


def fake_fetch(url, token=None):
    if "fields=xpGains" in url:
        if token != "good":
            raise urllib.error.HTTPError(url, 401, "Unauthorized", {}, None)
        return {"xpGains": [{"time": 1761400000, "xp": 15}, {"time": "bad"}, {"time": 1761403600, "xp": 0}]}
    if "username=ghost" in url:
        return {"users": []}
    return {"users": [{
        "id": 7, "username": "Ana", "streak": 12, "totalXp": 4321, "currentCourseId": "KO",
        "courses": [{"id": "ES", "title": "Spanish", "xp": 4000}, {"id": "KO", "title": "Korean", "xp": 321}],
    }]}


class LookupTests(unittest.TestCase):
    def setUp(self):
        server._cache.clear()
        patcher = mock.patch.object(server, "fetch_json", side_effect=fake_fetch)
        self.fetch = patcher.start()
        self.addCleanup(patcher.stop)

    def test_public_profile_uses_current_course(self):
        out = server.lookup("Ana")
        self.assertEqual(out["streak"], 12)
        self.assertEqual(out["totalXp"], 4321)
        self.assertEqual(out["courseTitle"], "Korean")
        self.assertEqual(out["courseXp"], 321)
        self.assertIsNone(out["gains"])

    def test_token_adds_gains_and_drops_malformed_entries(self):
        out = server.lookup("Ana", "good")
        self.assertEqual(out["gains"], [{"t": 1761400000, "xp": 15}, {"t": 1761403600, "xp": 0}])

    def test_rejected_token_falls_back_with_message(self):
        out = server.lookup("Ana", "bad")
        self.assertIsNone(out["gains"])
        self.assertIn("rejected", out["gainsError"])

    def test_unknown_user_and_bad_username(self):
        with self.assertRaises(server.RelayError) as e:
            server.lookup("ghost")
        self.assertEqual(e.exception.status, 404)
        with self.assertRaises(server.RelayError) as e:
            server.lookup("no spaces/allowed")
        self.assertEqual(e.exception.status, 400)

    def test_results_are_cached_briefly(self):
        server.lookup("Ana")
        server.lookup("ana")
        self.assertEqual(self.fetch.call_count, 1)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def get(self, path, headers=None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def test_api_passes_token_header_and_sets_cors(self):
        with mock.patch.object(server, "lookup", return_value={"streak": 1}) as lk:
            status, headers, body = self.get("/api/duolingo?username=Ana", {"X-Duo-Token": "tok"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"streak": 1})
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        lk.assert_called_once_with("Ana", "tok")

    def test_api_errors_are_json(self):
        with mock.patch.object(server, "lookup", side_effect=server.RelayError(404, "nope")):
            status, _, body = self.get("/api/duolingo?username=x")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"error": "nope"})

    def test_serves_app_and_manifest_type(self):
        status, _, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Lesson Tracker", body)
        status, headers, _ = self.get("/manifest.webmanifest")
        self.assertEqual(headers["Content-Type"], "application/manifest+json")


if __name__ == "__main__":
    unittest.main()
