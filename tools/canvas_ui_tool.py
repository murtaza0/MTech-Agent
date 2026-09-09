"""Compatibility module for the OpenHands agent-server preload hook.

MTech keeps this lightweight module so the server can import the historical
``canvas_ui_tool`` name used by persisted conversations. The module must be
safe to import before any browser, network, or MTech service is running.
"""

from __future__ import annotations


def register(*_args, **_kwargs) -> None:
    return None


__all__ = ["register"]
