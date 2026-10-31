// Races bots on every track and prints lap times, so track or physics changes can be checked quickly.
// Usage: npx tsx scripts/bots.ts [laps]
import { MAX_CARS, TICK_RATE, createRace, lapTime, progress, standings, stepRace } from "../src/shared/sim";
import { TRACKS, TRACK_IDS } from "../src/shared/tracks";

const laps = Number(process.argv[2] ?? 3);
for (const id of TRACK_IDS) {
  const track = TRACKS[id];
  const race = createRace(
    id,
    laps,
    Array.from({ length: MAX_CARS }, (_, i) => ({ id: `bot${i}`, name: `Bot ${i + 1}`, color: i, bot: true })),
  );
  let offroadTicks = 0;
  while (!race.over) {
    stepRace(race, new Map());
    offroadTicks += race.cars.filter((c) => c.offroad).length;
    race.events.length = 0;
  }
  const length = Math.round(track.path.length * track.spacing);
  console.log(
    `${track.name}: ${track.path.length} points (${length} px), ${track.circles.length} circles, ${track.rects.length} blocks, ${track.boosts.length} boosts, race ${lapTime(race.tick - race.startTick)}, offroad ${Math.round((offroadTicks * 100) / race.cars.length / race.tick)}%`,
  );
  for (const car of standings(race)) {
    console.log(
      `  ${car.name.padEnd(6)} ${car.status.padEnd(8)} laps ${Math.floor(car.cp / track.checkpoints.length)} best ${lapTime(car.bestLap)} progress ${Math.round(progress(race, car))}`,
    );
  }
}
console.log(`(${TICK_RATE} ticks/s)`);
