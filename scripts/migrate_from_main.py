#!/usr/bin/env python3
"""
Migrate users, BNG servers, BNG configs, and per-user settings from the
NW Automation Framework database into the BNGBlaster Web Client database.

Idempotent — primary keys are preserved so the script can be re-run safely.

Usage:
    python3 scripts/migrate_from_main.py \\
        --src postgresql+psycopg2://nw_user:nw_pass@OLD_HOST:5432/nw_automation \\
        --dst postgresql+psycopg2://bng_user:bng_pass@localhost:5433/bng_web
"""

import argparse
import sys

from sqlalchemy import create_engine, MetaData, Table, select
from sqlalchemy.dialects.postgresql import insert as pg_insert


TABLES = ["users", "bng_servers", "bng_configs", "app_settings"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", required=True, help="Source DATABASE_URL")
    ap.add_argument("--dst", required=True, help="Destination DATABASE_URL")
    args = ap.parse_args()

    src_engine = create_engine(args.src)
    dst_engine = create_engine(args.dst)

    src_meta = MetaData()
    dst_meta = MetaData()

    src_meta.reflect(bind=src_engine, only=TABLES)
    dst_meta.reflect(bind=dst_engine, only=TABLES)

    with src_engine.connect() as src_conn, dst_engine.begin() as dst_conn:
        for tbl_name in TABLES:
            if tbl_name not in src_meta.tables:
                print(f"[skip] {tbl_name}: not present in source DB")
                continue
            if tbl_name not in dst_meta.tables:
                print(f"[warn] {tbl_name}: not present in destination DB — start backend once to create tables")
                continue

            src_tbl: Table = src_meta.tables[tbl_name]
            dst_tbl: Table = dst_meta.tables[tbl_name]

            # Project only the columns that exist in BOTH tables
            common_cols = [c.name for c in src_tbl.columns if c.name in dst_tbl.columns]
            rows = src_conn.execute(select(*[src_tbl.c[c] for c in common_cols])).mappings().all()

            if not rows:
                print(f"[ok]   {tbl_name}: 0 rows")
                continue

            stmt = pg_insert(dst_tbl).values([dict(r) for r in rows]).on_conflict_do_nothing()
            res = dst_conn.execute(stmt)
            print(f"[ok]   {tbl_name}: copied {res.rowcount}/{len(rows)} rows (rest already present)")

    print("\nDone. You may now log in to the new app with existing credentials.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
