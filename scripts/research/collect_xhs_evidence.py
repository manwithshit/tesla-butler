#!/usr/bin/env python3
"""采集本次小红书调研证据，仅保存规范笔记链接，不持久化签名 Token。"""

from __future__ import annotations

import json
import re
import subprocess
from collections import defaultdict
from datetime import datetime
from pathlib import Path


OPENCLI = "/usr/local/bin/opencli"
ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "data/processed/research/xhs"
QUERIES = [
    "MyTess",
    "MyTesla",
    "MyTes",
    "特特管家",
    "特斯拉 数据",
    "特斯拉 能耗",
    "特斯拉 行程统计",
    "特斯拉 驾驶评分",
]
RELEVANT = re.compile(
    r"mytess|mytes|特特管家|特斯拉|tesla|teslamate|数据|能耗|电耗|行程|驾驶|充电|电池|费用|报告|续航|记录",
    re.I,
)
QUESTION_OR_PRODUCT = re.compile(
    r"mytess|特特管家|数据|能耗|电耗|行程|驾驶|充电|电池|费用|报告|续航|记录|怎么看|高吗|为什么|多少|缺失|难用|不准",
    re.I,
)


def run_opencli(args: list[str]) -> object:
    result = subprocess.run(
        [OPENCLI, "xiaohongshu", *args, "-f", "json"],
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    output = (result.stdout or "") + (result.stderr or "")
    starts = [pos for pos in (output.find("["), output.find("{")) if pos >= 0]
    if not starts:
        raise RuntimeError(output[:500] or f"opencli exit={result.returncode}")
    return json.JSONDecoder().raw_decode(output[min(starts) :])[0]


def canonical_url(url: str) -> str:
    return url.split("?", 1)[0].rstrip("/")


def note_id(url: str) -> str:
    return canonical_url(url).rsplit("/", 1)[-1]


def to_int(value: object) -> int:
    text = str(value or "").strip().replace(",", "")
    match = re.match(r"([\d.]+)\s*(万|w|W)?", text)
    if not match:
        return 0
    number = float(match.group(1))
    if match.group(2):
        number *= 10000
    return int(number)


def flatten_note(rows: object) -> dict[str, object]:
    if isinstance(rows, list):
        return {
            str(row.get("field")): row.get("value")
            for row in rows
            if isinstance(row, dict) and row.get("field")
        }
    return rows if isinstance(rows, dict) else {}


def sanitize_search(query: str, row: dict[str, object]) -> dict[str, object]:
    return {
        "检索词": query,
        "排名": row.get("rank"),
        "标题": row.get("title", ""),
        "作者显示名": row.get("author", ""),
        "点赞数": to_int(row.get("likes")),
        "发布时间": row.get("published_at", ""),
        "笔记链接": canonical_url(str(row.get("url", ""))),
    }


def candidate_score(query: str, row: dict[str, object]) -> tuple[int, int]:
    title = str(row.get("title", ""))
    author = str(row.get("author", ""))
    score = 0
    if RELEVANT.search(f"{title} {author}"):
        score += 2
    if QUESTION_OR_PRODUCT.search(title):
        score += 3
    if query.lower() in f"{title} {author}".lower():
        score += 4
    if query in {"MyTess", "MyTesla", "MyTes", "特特管家"} and re.search(
        r"mytess|mytes|特特管家", f"{title} {author}", re.I
    ):
        score += 5
    return score, to_int(row.get("likes"))


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    searches: dict[str, list[dict[str, object]]] = {}
    signed_by_id: dict[str, str] = {}
    raw_by_id: dict[str, dict[str, object]] = {}
    failures: list[dict[str, str]] = []

    for query in QUERIES:
        try:
            rows = run_opencli(["search", query, "--limit", "15"])
            rows = rows if isinstance(rows, list) else []
        except Exception as error:
            rows = []
            failures.append({"阶段": "search", "对象": query, "错误": str(error)[:300]})
        searches[query] = [sanitize_search(query, row) for row in rows if isinstance(row, dict)]
        for row in rows:
            if not isinstance(row, dict) or not row.get("url"):
                continue
            nid = note_id(str(row["url"]))
            signed_by_id[nid] = str(row["url"])
            raw_by_id[nid] = row

    selected_ids: set[str] = set()
    for query in QUERIES:
        query_rows = [raw_by_id[note_id(str(row["url"]))] for row in raw_by_id.values() if False]
        # 每个检索词最多选 5 条，优先产品本人、用户问题和高互动帖子。
        candidates = []
        for row in [r for r in raw_by_id.values() if isinstance(r, dict)]:
            url = str(row.get("url", ""))
            nid = note_id(url) if url else ""
            if not nid:
                continue
            if not any(s.get("笔记链接") == canonical_url(url) for s in searches[query]):
                continue
            score = candidate_score(query, row)
            if score[0] > 0:
                candidates.append((score, nid))
        candidates.sort(reverse=True)
        selected_ids.update(nid for _, nid in candidates[:5])

    details: list[dict[str, object]] = []
    comments: list[dict[str, object]] = []
    for nid in sorted(selected_ids):
        signed_url = signed_by_id[nid]
        raw = raw_by_id[nid]
        try:
            detail = flatten_note(run_opencli(["note", signed_url]))
        except Exception as error:
            failures.append({"阶段": "note", "对象": nid, "错误": str(error)[:300]})
            detail = {}
        record = {
            "笔记ID": nid,
            "标题": detail.get("title") or raw.get("title", ""),
            "作者显示名": detail.get("author") or raw.get("author", ""),
            "正文": detail.get("content", ""),
            "点赞数": to_int(detail.get("likes") or raw.get("likes")),
            "收藏数": to_int(detail.get("collects")),
            "评论数_页面显示": to_int(detail.get("comments")),
            "话题": detail.get("tags", ""),
            "发布时间": raw.get("published_at", ""),
            "笔记链接": canonical_url(signed_url),
        }
        details.append(record)

        # 页面有评论时优先抓；即使显示为 0，也尝试一次以识别页面计数与接口差异。
        try:
            rows = run_opencli(["comments", signed_url, "--limit", "50"])
            rows = rows if isinstance(rows, list) else []
        except Exception as error:
            failures.append({"阶段": "comments", "对象": nid, "错误": str(error)[:300]})
            rows = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            comments.append(
                {
                    "笔记ID": nid,
                    "笔记标题": record["标题"],
                    "评论内容": row.get("text", ""),
                    "点赞数": to_int(row.get("likes")),
                    "是否回复": bool(row.get("is_reply")),
                    "评论时间原文": row.get("time", ""),
                    "笔记链接": canonical_url(signed_url),
                }
            )

    # 去除同一笔记被多个检索词重复命中的结果，但保留各检索词命中清单。
    unique_search_count = len(
        {
            row["笔记链接"]
            for rows in searches.values()
            for row in rows
            if row.get("笔记链接")
        }
    )
    meta = {
        "采集时间": datetime.now().astimezone().isoformat(timespec="seconds"),
        "检索词": QUERIES,
        "每个检索词请求上限": 15,
        "各检索词返回数": {query: len(rows) for query, rows in searches.items()},
        "检索返回总条次_含重复": sum(len(rows) for rows in searches.values()),
        "唯一笔记数": unique_search_count,
        "详情抓取数": len(details),
        "评论抓取数": len(comments),
        "失败数": len(failures),
        "说明": "仅保存去除 xsec_token 的规范链接；评论不保存评论者身份。",
    }

    payloads = {
        "search_results.json": {"meta": meta, "results": searches},
        "note_details.json": {"meta": meta, "notes": details},
        "comments.json": {"meta": meta, "comments": comments},
        "failures.json": {"meta": meta, "failures": failures},
    }
    for filename, payload in payloads.items():
        (OUT_DIR / filename).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
