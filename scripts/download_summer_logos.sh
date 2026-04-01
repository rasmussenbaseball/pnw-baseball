#!/bin/bash
# Download summer team logos to serve locally
# Run on server: bash /opt/pnw-baseball/scripts/download_summer_logos.sh

LOGO_DIR="/opt/pnw-baseball/frontend/dist/logos/summer"
mkdir -p "$LOGO_DIR"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

echo "Downloading WCL logos..."
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/06/Bellingham-Bells-Logo.png" -o "$LOGO_DIR/bellingham-bells.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/logos/EDM-LOGO.png" -o "$LOGO_DIR/edmonton-riverhawks.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2020/09/kamloops-northpaws-logo-SM27.png" -o "$LOGO_DIR/kamloops-northpaws.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/10/Kelowna-Falcons-Icon.png" -o "$LOGO_DIR/kelowna-falcons.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/05/Nanaimo-NightOwls-Logo.png" -o "$LOGO_DIR/nanaimo-nightowls.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/10/Port-Angeles-Lefties-Icon.png" -o "$LOGO_DIR/port-angeles-lefties.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/05/Victoria-Harbourcats-Icon-1.png" -o "$LOGO_DIR/victoria-harbourcats.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/05/Wenatchee-Applesox-Icon.png" -o "$LOGO_DIR/wenatchee-applesox.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/06/Bend-Elks-New.png" -o "$LOGO_DIR/bend-elks.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/05/Corvallis-Knights-Icon-1.png" -o "$LOGO_DIR/corvallis-knights.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/10/Cowlitz-Black-Bears-Icon.png" -o "$LOGO_DIR/cowlitz-black-bears.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2024/11/Berries-300x300.png" -o "$LOGO_DIR/marion-berries.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/05/Portland-Pickles-Icon.png" -o "$LOGO_DIR/portland-pickles.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/10/Ridgefield-Raptors-Icons-b.png" -o "$LOGO_DIR/ridgefield-raptors.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2021/04/Drifters-logo-e1745387379978.png" -o "$LOGO_DIR/springfield-drifters.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/10/Walla-Walla-Sweets-Icon.png" -o "$LOGO_DIR/walla-walla-sweets.png"
curl -sL -A "$UA" "https://westcoastleague.com/wp-content/uploads/2019/10/Yakima-Pippins-Icon.png" -o "$LOGO_DIR/yakima-valley-pippins.png"

echo "Downloading PIL logos..."
curl -sL -A "$UA" "https://www.pacificinternationalleague.com/wp-content/uploads/2023/11/Fish-Sticks-Main-Logo-300x232.png" -o "$LOGO_DIR/dubsea-fish-sticks.png"
curl -sL -A "$UA" "https://www.pacificinternationalleague.com/wp-content/uploads/2019/10/Merchants2020.jpg" -o "$LOGO_DIR/everett-merchants.jpg"
curl -sL -A "$UA" "https://www.pacificinternationalleague.com/wp-content/uploads/2019/10/Honkers2020n.jpg" -o "$LOGO_DIR/northwest-honkers.jpg"
curl -sL -A "$UA" "https://www.pacificinternationalleague.com/wp-content/uploads/2020/02/DUDESTRANS-300x298.png" -o "$LOGO_DIR/redmond-dudes.png"
curl -sL -A "$UA" "https://www.pacificinternationalleague.com/wp-content/uploads/2023/11/Seattle-Blackfins-Logo-281x300.jpeg" -o "$LOGO_DIR/seattle-blackfins.jpeg"
curl -sL -A "$UA" "https://www.pacificinternationalleague.com/wp-content/uploads/2019/10/SeattleStuds2020.jpg" -o "$LOGO_DIR/seattle-cheney-studs.jpg"
curl -sL -A "$UA" "https://www.pacificinternationalleague.com/wp-content/uploads/2023/11/Gumberoos-Header-291x300.png" -o "$LOGO_DIR/the-gumberoos.png"

echo "Done! Downloaded logos to $LOGO_DIR"
ls -la "$LOGO_DIR"
