"""Bound one upstream attempt; retries belong to the bridge, not both layers.

Requires gemini-webapi's documented-by-source current_retry wrapper argument.
A deadline never triggers automatic regeneration: a previous request may have
already consumed quota. Cancelling also closes the upstream async generator.
"""
import asyncio
import os
from contextlib import aclosing

IDLE_SECONDS = float(os.getenv("STREAM_IDLE_SECONDS", "90"))


class GenerationDeadlineExceeded(RuntimeError):
    pass


class GenerationStalled(GenerationDeadlineExceeded):
    pass


async def generate_once(client, *, deadline_seconds=120, idle_seconds=IDLE_SECONDS, **kwargs):
    try:
        async with asyncio.timeout(deadline_seconds):
            # Installed gemini-webapi 2.1.1 @running wrapper otherwise retries
            # APIError five times, potentially resending the same prompt.
            async with aclosing(client._generate(current_retry=0, **kwargs)) as upstream:
                iterator = upstream.__aiter__()
                while True:
                    # A total deadline is not enough. Google can accept the
                    # prompt, send one empty chunk and then go silent; the SSE
                    # loop only checks for a disconnected client when a chunk
                    # arrives, so the IDE span until its own timeout.
                    try:
                        chunk = await asyncio.wait_for(iterator.__anext__(), idle_seconds)
                    except StopAsyncIteration:
                        return
                    except TimeoutError:
                        raise GenerationStalled(
                            f"Google не прислал ни одного фрагмента за {idle_seconds:.0f} с. "
                            "Генерация прервана, автоматический повтор не выполнен."
                        ) from None
                    yield chunk
    except TimeoutError as exc:
        raise GenerationDeadlineExceeded(
            "Время ожидания одной генерации истекло. Автоматический повтор не выполнен."
        ) from exc
