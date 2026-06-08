-- Innings-pitched summation helpers.
--
-- innings_pitched is stored in BASEBALL NOTATION: the fractional digit is a
-- count of outs, not a decimal fraction. .1 = 1 out (1/3 inning), .2 = 2 outs
-- (2/3 inning). Only .0/.1/.2 are valid.
--
-- Summing these values with a plain SUM() is WRONG: SQL treats .1 as 0.1 and
-- .2 as 0.2, so totals undercount true innings and produce impossible fractions
-- (.4/.6/.8). That skewed every team/career/league IP total and the league
-- averages that feed the FIP constant.
--
-- Correct pattern:
--   true innings (for rate-stat math):   SUM(ip_outs(innings_pitched)) / 3.0
--   display total (baseball notation):   outs_to_ip(SUM(ip_outs(innings_pitched)))
--
-- Both functions are pure/immutable so the planner can fold them. Parameter
-- types are chosen to accept the real innings_pitched column (double precision)
-- and the bigint that SUM(integer) yields without explicit casts at call sites.

-- Drop any earlier signatures so CREATE below can set the final arg/return types.
DROP FUNCTION IF EXISTS ip_outs(numeric);
DROP FUNCTION IF EXISTS ip_outs(double precision);
DROP FUNCTION IF EXISTS outs_to_ip(integer);
DROP FUNCTION IF EXISTS outs_to_ip(bigint);

-- One baseball-notation IP value -> total outs. e.g. 45.2 -> 137 outs.
CREATE FUNCTION ip_outs(ip double precision)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN ip IS NULL THEN 0
           ELSE FLOOR(ip)::int * 3 + ROUND((ip - FLOOR(ip)) * 10)::int
         END
$$;

-- Total outs -> baseball notation. e.g. 137 outs -> 45.2 (45 and 2/3).
-- Takes bigint so SUM(ip_outs(...)) (a bigint) needs no cast.
CREATE FUNCTION outs_to_ip(outs bigint)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN outs IS NULL THEN 0
           ELSE (outs / 3)::numeric + ((outs % 3)::numeric / 10.0)
         END
$$;
