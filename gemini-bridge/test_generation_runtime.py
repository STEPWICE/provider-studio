import asyncio
import unittest

from gemini_webapi.exceptions import APIError
from gemini_webapi.utils.decorators import running
from generation_runtime import generate_once, GenerationDeadlineExceeded, GenerationStalled


class FakeClient:
    _running = True

    def __init__(self, mode):
        self.mode = mode
        self.calls = 0
        self.closed = False
        self.generator_closed = False

    async def close(self):
        self.closed = True

    @running(retry=5)
    async def _generate(self):
        self.calls += 1
        try:
            if self.mode == "error":
                raise APIError("test upstream failure")
            yield "first"
            if self.mode == "stall":
                await asyncio.sleep(60)
            if self.mode == "slow":
                for i in range(4):
                    await asyncio.sleep(0.03)
                    yield f"part{i}"
            yield "last"
        finally:
            self.generator_closed = True


class GenerationRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_library_decorator_does_not_retry(self):
        client = FakeClient("error")
        with self.assertRaises(APIError):
            async for _ in generate_once(client):
                pass
        self.assertEqual(client.calls, 1)
        self.assertTrue(client.generator_closed)

    async def test_deadline_closes_stalled_upstream_without_replay(self):
        client = FakeClient("stall")
        chunks = []
        with self.assertRaises(GenerationDeadlineExceeded):
            async for chunk in generate_once(client, deadline_seconds=0.02):
                chunks.append(chunk)
        self.assertEqual(chunks, ["first"])
        self.assertEqual(client.calls, 1)
        self.assertTrue(client.generator_closed)

    async def test_cancellation_closes_upstream(self):
        client = FakeClient("stall")
        first = asyncio.Event()

        async def consume():
            async for _ in generate_once(client):
                first.set()

        task = asyncio.create_task(consume())
        await first.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(client.generator_closed)
        self.assertEqual(client.calls, 1)

    async def test_success_preserves_chunks(self):
        client = FakeClient("ok")
        self.assertEqual([item async for item in generate_once(client)], ["first", "last"])
        self.assertTrue(client.generator_closed)

    async def test_silent_upstream_is_cut_before_the_total_deadline(self):
        # Observed live: one empty chunk, then three minutes of silence while the
        # IDE waited. The total deadline alone left the turn hanging.
        client = FakeClient("stall")
        chunks = []
        with self.assertRaises(GenerationStalled):
            async for chunk in generate_once(client, deadline_seconds=30, idle_seconds=0.05):
                chunks.append(chunk)
        self.assertEqual(chunks, ["first"])
        self.assertEqual(client.calls, 1)
        self.assertTrue(client.generator_closed)

    async def test_steady_stream_slower_than_the_idle_gap_survives(self):
        client = FakeClient("slow")
        chunks = [item async for item in generate_once(client, deadline_seconds=30, idle_seconds=0.5)]
        self.assertEqual(chunks, ["first", "part0", "part1", "part2", "part3", "last"])
        self.assertTrue(client.generator_closed)

    async def test_stall_is_a_deadline_so_existing_handlers_still_apply(self):
        self.assertTrue(issubclass(GenerationStalled, GenerationDeadlineExceeded))


if __name__ == "__main__":
    unittest.main()
