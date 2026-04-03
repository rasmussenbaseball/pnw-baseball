-- Set summer team logo URLs
-- These logos live in /opt/pnw-baseball/frontend/public/logos/summer/ (Vite copies them to dist/ on build)

-- WCL Teams
UPDATE summer_teams SET logo_url = '/logos/summer/bellingham-bells.png' WHERE id = 1;
UPDATE summer_teams SET logo_url = '/logos/summer/edmonton-riverhawks.png' WHERE id = 2;
UPDATE summer_teams SET logo_url = '/logos/summer/kamloops-northpaws.png' WHERE id = 3;
UPDATE summer_teams SET logo_url = '/logos/summer/kelowna-falcons.png' WHERE id = 4;
UPDATE summer_teams SET logo_url = '/logos/summer/nanaimo-nightowls.png' WHERE id = 5;
UPDATE summer_teams SET logo_url = '/logos/summer/port-angeles-lefties.png' WHERE id = 6;
UPDATE summer_teams SET logo_url = '/logos/summer/victoria-harbourcats.png' WHERE id = 7;
UPDATE summer_teams SET logo_url = '/logos/summer/wenatchee-applesox.png' WHERE id = 8;
UPDATE summer_teams SET logo_url = '/logos/summer/bend-elks.png' WHERE id = 9;
UPDATE summer_teams SET logo_url = '/logos/summer/corvallis-knights.png' WHERE id = 10;
UPDATE summer_teams SET logo_url = '/logos/summer/cowlitz-black-bears.png' WHERE id = 11;
UPDATE summer_teams SET logo_url = '/logos/summer/marion-berries.png' WHERE id = 12;
UPDATE summer_teams SET logo_url = '/logos/summer/portland-pickles.png' WHERE id = 13;
UPDATE summer_teams SET logo_url = '/logos/summer/ridgefield-raptors.png' WHERE id = 14;
UPDATE summer_teams SET logo_url = '/logos/summer/springfield-drifters.svg' WHERE id = 15;
UPDATE summer_teams SET logo_url = '/logos/summer/walla-walla-sweets.png' WHERE id = 16;
UPDATE summer_teams SET logo_url = '/logos/summer/yakima-valley-pippins.png' WHERE id = 17;

-- PIL Teams
UPDATE summer_teams SET logo_url = '/logos/summer/dubsea-fish-sticks.png' WHERE id = 19;
UPDATE summer_teams SET logo_url = '/logos/summer/everett-merchants.jpg' WHERE id = 20;
UPDATE summer_teams SET logo_url = '/logos/summer/northwest-honkers.jpg' WHERE id = 21;
UPDATE summer_teams SET logo_url = '/logos/summer/redmond-dudes.png' WHERE id = 22;
UPDATE summer_teams SET logo_url = '/logos/summer/seattle-blackfins.jpeg' WHERE id = 23;
UPDATE summer_teams SET logo_url = '/logos/summer/seattle-cheney-studs.jpg' WHERE id = 24;
UPDATE summer_teams SET logo_url = '/logos/summer/the-gumberoos.png' WHERE id = 26;
-- Seattle Samurai (id=25) - no logo found
