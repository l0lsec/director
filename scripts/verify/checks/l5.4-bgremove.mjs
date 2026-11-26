import { assert } from '../lib.mjs';
// Strict form: IoU against a ground-truth person mask needs a person fixture, which the repo does not ship.
export default async function () {
  assert(process.env.DIRECTOR_PERSON_FIXTURE, 'set DIRECTOR_PERSON_FIXTURE to a clip of a person plus DIRECTOR_PERSON_MASK to its ground-truth mask video');
  return 'not run';
}
