import L from "leaflet";

const DEFAULT_MIN_ARM_METERS = 0.05;
const DEFAULT_SNAP_THRESHOLD_DEG = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeAngleDeg(value: number): number {
  let angle = value % 360;
  if (angle < 0) angle += 360;
  return angle;
}

function shortestAngleDistanceDeg(a: number, b: number): number {
  const delta = Math.abs(normalizeAngleDeg(a) - normalizeAngleDeg(b));
  return Math.min(delta, 360 - delta);
}

export function calculateProtractorAngleDeg(
  vertex: L.LatLng,
  armA: L.LatLng,
  armB: L.LatLng,
  minArmMeters = DEFAULT_MIN_ARM_METERS
): number | null {
  const origin = L.CRS.EPSG3857.project(vertex);
  const first = L.CRS.EPSG3857.project(armA);
  const second = L.CRS.EPSG3857.project(armB);

  const vectorA = {
    x: first.x - origin.x,
    y: first.y - origin.y
  };
  const vectorB = {
    x: second.x - origin.x,
    y: second.y - origin.y
  };
  const lengthA = Math.hypot(vectorA.x, vectorA.y);
  const lengthB = Math.hypot(vectorB.x, vectorB.y);
  if (!Number.isFinite(lengthA) || !Number.isFinite(lengthB)) return null;
  if (lengthA < minArmMeters || lengthB < minArmMeters) return null;

  const denominator = lengthA * lengthB;
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const cosine = clamp((vectorA.x * vectorB.x + vectorA.y * vectorB.y) / denominator, -1, 1);
  const angle = (Math.acos(cosine) * 180) / Math.PI;
  if (!Number.isFinite(angle)) return null;
  return angle;
}

export function snapToCartesianAxis(
  vertex: L.LatLng,
  rawPoint: L.LatLng,
  thresholdDeg = DEFAULT_SNAP_THRESHOLD_DEG,
  minArmMeters = DEFAULT_MIN_ARM_METERS
): L.LatLng {
  const origin = L.CRS.EPSG3857.project(vertex);
  const target = L.CRS.EPSG3857.project(rawPoint);
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < minArmMeters) return rawPoint;

  const angleDeg = normalizeAngleDeg((Math.atan2(dy, dx) * 180) / Math.PI);
  const axisCandidates = [0, 90, 180, 270];
  let closestAxisDeg = axisCandidates[0];
  let closestDistanceDeg = shortestAngleDistanceDeg(angleDeg, closestAxisDeg);
  for (let index = 1; index < axisCandidates.length; index += 1) {
    const candidate = axisCandidates[index];
    const distance = shortestAngleDistanceDeg(angleDeg, candidate);
    if (distance < closestDistanceDeg) {
      closestDistanceDeg = distance;
      closestAxisDeg = candidate;
    }
  }

  if (closestDistanceDeg > thresholdDeg) return rawPoint;
  const snappedRad = (closestAxisDeg * Math.PI) / 180;
  const snappedPoint = new L.Point(origin.x + Math.cos(snappedRad) * length, origin.y + Math.sin(snappedRad) * length);
  return L.CRS.EPSG3857.unproject(snappedPoint);
}
