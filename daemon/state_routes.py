"""HTTP adapter for daemon/state.py — per-document viewer state.

  GET /entry/{hash}/state        -> {key: {"value": ..., "ts": ms}}
  PUT /entry/{hash}/state/{key}  body {"value": ..., "ts": ms}
                                 -> the stored row after last-writer-wins
  DELETE /entry/{hash}/state     -> {"deleted": rows}; test-harness reset

The overlay detects these routes through /openapi.json before calling them,
so a daemon without them never produces a 404 in the page console.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request

import state

router = APIRouter()


@router.get("/entry/{hash_}/state")
def get_state(hash_: str):
    try:
        return state.get_all(hash_)
    except state.InvalidState as error:
        raise HTTPException(400, str(error)) from error


@router.put("/entry/{hash_}/state/{key}")
async def put_state(hash_: str, key: str, request: Request):
    raw = await request.body()
    if len(raw) > state.MAX_VALUE_BYTES + 1024:
        raise HTTPException(400, "body too large")
    try:
        body = json.loads(raw or b"null")
    except ValueError as error:
        raise HTTPException(400, "body must be JSON") from error
    if not isinstance(body, dict) or "value" not in body or "ts" not in body:
        raise HTTPException(400, 'body must be {"value": ..., "ts": <ms>}')
    try:
        return state.put(hash_, key, body["value"], body["ts"])
    except state.InvalidState as error:
        raise HTTPException(400, str(error)) from error


@router.delete("/entry/{hash_}/state")
def delete_state(hash_: str):
    try:
        state.get_all(hash_)  # validates the hash
    except state.InvalidState as error:
        raise HTTPException(400, str(error)) from error
    return {"deleted": state.forget(hash_)}
