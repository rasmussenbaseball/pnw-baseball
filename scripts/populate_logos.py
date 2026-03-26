#!/usr/bin/env python3
"""
Populate team logo URLs in the database.

Sidearm sites: CloudFront CDN with predictable path
NWAC sites: nwacsports.com/images/setup/team_logos/
"""

import sqlite3
import sys
from pathlib import Path

DB_PATH = str(Path(__file__).parent.parent / "backend" / "data" / "pnw_baseball.db")

# CloudFront CDN base for Sidearm sites
CF = "https://dxbhsrqyrr690.cloudfront.net/sidearm.nextgen.sites"

# Map: team short_name → logo URL
# Sidearm pattern: {CF}/{sidearm_domain}/images/responsive_2020/{slug}_logo.svg
LOGO_MAP = {
    # ── NCAA D1 ──
    # D1 sites use unique Sidearm domains and folder structures
    "UW":           f"{CF}/washington.sidearmsports.com/images/sng_2025/logo_main.svg",
    "Oregon":       f"{CF}/uoregon.sidearmsports.com/images/sng_2023/main_nav_logo.svg",
    "Oregon St.":   f"{CF}/oregonstate.sidearmsports.com/images/sng_2022/nav_mainlogo.svg",
    "Wash. St.":    "/logos/washington_state.png",
    "Portland":     f"{CF}/portlandpilots.com/images/responsive_2023/logo_main.svg",
    "Gonzaga":      f"{CF}/gozags.com/images/logos/site/site.png",
    "Seattle U":    "https://upload.wikimedia.org/wikipedia/commons/2/24/Seattle_Redhawks_logo.svg",

    # ── NCAA D2 (GNAC) ──
    "CWU":          f"{CF}/wildcatsports.com/images/responsive_2020/logo_main.svg",
    "SMU":          "https://smusaints.com/images/logos/site/site.png",
    "MSUB":         "https://msubsports.com/images/logos/site/site.png",
    "WOU":          "https://wouwolves.com/images/logos/site/site.png",
    "NNU":          "https://nnusports.com/images/logos/site/site.png",

    # ── NCAA D3 (NWC) ──
    "UPS":          "https://loggerathletics.com/images/logos/site/site.png",
    "PLU":          f"{CF}/plu.sidearmsports.com/images/responsive_2022/logo_main.svg",
    "Whitman":      f"{CF}/whitman.sidearmsports.com/images/responsive_2024/logo_main.svg",
    "Whitworth":    "https://whitworthpirates.com/images/logos/site/site.png",
    # Linfield, Willamette, and George Fox use React SPAs — logos served locally
    "Linfield":     "/logos/linfield.svg",
    "Willamette":   "/logos/willamette.svg",
    "GFU":          "/logos/george_fox.png",
    "L&C":          "https://golcathletics.com/images/logos/site/site.png",
    "Pacific":      "https://goboxers.com/images/logos/site/site.png",

    # ── NAIA (CCC) ──
    "EOU":          f"{CF}/eousports.com/images/responsive_2020/logo_main.png",
    "OIT":          f"{CF}/oit.sidearmsports.com/images/responsive_2023/logo_main.svg",
    "C of I":       f"{CF}/collegeofidaho.sidearmsports.com/images/responsive_2020/main_logo.svg",
    "LCSC":         f"{CF}/lcsc.sidearmsports.com/images/responsive_2020/lcsc_logo.svg",
    "Corban":       f"{CF}/gowarriorsgo.com/images/responsive/logo-main.svg",
    "Bushnell":     "/logos/bushnell.png",
    "Warner Pacific": f"{CF}/wpcknights.sidearmsports.com/images/responsive_2020/logo_main_new.png",
    "UBC":          f"{CF}/gothunderbirds.ca/images/responsive2019/main_logo.svg",

    # ── NWAC North ──
    "Bellevue":         "https://nwacsports.com/images/setup/team_logos/Bellevue.png",
    "Douglas":          "https://nwacsports.com/images/setup/team_logos/Douglas.png",
    "Edmonds":          "https://nwacsports.com/images/setup/team_logos/EdmondsCollege.png",
    "Everett":          "https://nwacsports.com/images/setup/team_logos/EverettCC-Featherstar.png",
    "Shoreline":        "https://nwacsports.com/images/setup/team_logos/Shoreline.png",
    "Skagit":           "https://nwacsports.com/images/setup/team_logos/Skagit_Valley.png",

    # ── NWAC East ──
    "Big Bend":         "https://nwacsports.com/images/setup/team_logos/Big_Bend.png",
    "Columbia Basin":   "https://nwacsports.com/images/setup/team_logos/Columbia_Basin_.png",
    "Spokane":          "https://nwacsports.com/images/setup/team_logos/spokane_nwac.png",
    "Treasure Valley":  "https://nwacsports.com/images/setup/team_logos/Treasure_Valley_New.png",
    "Walla Walla":      "https://nwacsports.com/images/setup/team_logos/Walla_Walla.png",
    "Wenatchee Valley": "https://nwacsports.com/images/setup/team_logos/Wenatchee_Valley.png",
    "Yakima Valley":    "https://nwacsports.com/images/setup/team_logos/Yakima_Valley_2.png",
    "Blue Mountain":    "https://nwacsports.com/images/setup/team_logos/Blue_Mountain.png",

    # ── NWAC South ──
    "Chemeketa":    "https://nwacsports.com/images/setup/team_logos/Chemeketa.png",
    "Clackamas":    "https://nwacsports.com/images/setup/team_logos/Clackamas.png",
    "Lane":         "https://nwacsports.com/images/setup/team_logos/Lane.png",
    "Linn-Benton":  "https://nwacsports.com/images/setup/team_logos/Linn_Benton.png",
    "Mt. Hood":     "https://nwacsports.com/images/setup/team_logos/MHCC.png",
    "SW Oregon":    "https://nwacsports.com/images/setup/team_logos/SW_Oregon.png",
    "Umpqua":       "https://nwacsports.com/images/setup/team_logos/Umpqua_Head.png",

    # ── NWAC West ──
    "Centralia":        "https://nwacsports.com/images/setup/team_logos/Centralia.png",
    "Clark":            "https://nwacsports.com/images/setup/team_logos/Clark.png",
    "Grays Harbor":     "https://nwacsports.com/images/setup/team_logos/Grays_Harbor_.png",
    "Olympic":          "https://nwacsports.com/images/setup/team_logos/Olympic.png",
    "Pierce":           "https://nwacsports.com/images/setup/team_logos/Pierce.png",
    "Lower Columbia":   "https://nwacsports.com/images/setup/team_logos/LCC.png",
    "Tacoma":           "https://nwacsports.com/images/setup/team_logos/Tacoma.png",
    "GRC":              "https://nwacsports.com/images/setup/team_logos/Green_River.png",
}


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Get all teams
    teams = conn.execute("SELECT id, short_name, name, logo_url FROM teams").fetchall()
    print(f"Found {len(teams)} teams in database")

    updated = 0
    missing = []

    for team in teams:
        short = team["short_name"]
        logo_url = LOGO_MAP.get(short)

        if not logo_url:
            missing.append(short)
            continue

        conn.execute("UPDATE teams SET logo_url = ? WHERE id = ?", (logo_url, team["id"]))
        updated += 1

    conn.commit()
    conn.close()

    print(f"Updated {updated} teams with logo URLs")
    if missing:
        print(f"Missing logos for {len(missing)} teams: {missing}")


if __name__ == "__main__":
    main()
