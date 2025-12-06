# Congestion pricing and Citi Bike

**Weekday Citi Bike trips ending in the congestion zone rose 10.7% after pricing began, slightly less than the 12.2% rise elsewhere (-1.5 points): no sign of a congestion-pricing boost.**

**Method.** Cleaned trips, split by end station inside/outside the zone (Manhattan at and below 60th St). 58 weekdays, 6 Jan–31 Mar 2025, vs the same weekdays 364 days earlier. Headline: zone % change minus outside % change.

| trips/weekday | 2024 | 2025 | change |
|---|---|---|---|
| Ending in zone | 40,307 | 44,624 | +10.7% |
| Ending outside | 37,653 | 42,263 | +12.2% |
| …started outside zone | 4,764 | 4,957 | +4.0% |

DiD: **-1.5 pts**; growth ratio 0.986 (95% range 0.974–0.995, from day pairs).

**Caveats**
- Weather: the 2025 window was 35.4°F vs 38.8°F with 11 vs 16 wet days; DiD removes citywide weather, not effects that differ by area.
- Network: end stations 396→405 in zone, 1883→1879 outside; counting only stations open in both windows gives -2.1 pts. Fleet size isn't public.
- E-bike share rose 65%→70%.
- MLK and Presidents' Day pairs excluded. Other trends aren't controlled, so this is not causal.
