from __future__ import annotations

import argparse
from pathlib import Path
import json
from typing import Any

from navegacion_gps.nav_benchmarking import comparison_direction
from navegacion_gps.nav_benchmarking import extract_key_metrics
from navegacion_gps.nav_benchmarking import json_ready


KEY_METRICS = (
    "success",
    "final_goal_error_m",
    "duration_s",
    "map_base_lateral_max_abs_m",
    "map_odom_jump_count",
    "map_odom_jump_max_abs_deg",
    "map_base_jump_count",
    "gps_heading_valid_ratio",
)


def _load_session(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _runs_by_scenario(session: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(run.get("scenario", {}).get("id", f"run_{index}")): run
        for index, run in enumerate(session.get("runs", []))
    }


def _fmt_value(value: Any) -> str:
    if value is None:
        return "N/A"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return f"{float(value):.3f}"
    return str(value)


def _delta_for_metric(metric_name: str, baseline_value: Any, candidate_value: Any) -> str:
    if baseline_value is None or candidate_value is None:
        return "N/A"
    if isinstance(baseline_value, bool) or isinstance(candidate_value, bool):
        if baseline_value == candidate_value:
            return "sin cambio"
        return "mejora" if bool(candidate_value) and not bool(baseline_value) else "regresion"
    delta = float(candidate_value) - float(baseline_value)
    direction = comparison_direction(metric_name)
    if abs(delta) < 1.0e-6:
        verdict = "sin cambio"
    elif (direction == "lower" and delta < 0.0) or (direction == "higher" and delta > 0.0):
        verdict = "mejora"
    else:
        verdict = "regresion"
    return f"{delta:+.3f} ({verdict})"


def _print_single_session(path: Path, session: dict[str, Any]) -> None:
    aggregate = session.get("aggregate", {})
    print(f"Archivo: {path}")
    print(
        f"Perfil={session.get('profile', 'N/A')} "
        f"escenarios={aggregate.get('scenario_count', len(session.get('runs', [])))} "
        f"success={aggregate.get('success_count', 0)} "
        f"timeout={aggregate.get('timeout_count', 0)}"
    )
    for run in session.get("runs", []):
        scenario = run.get("scenario", {})
        metrics = extract_key_metrics(run)
        print(
            f"  - {scenario.get('id', 'N/A')}: "
            f"success={_fmt_value(metrics['success'])} "
            f"final_error_m={_fmt_value(metrics['final_goal_error_m'])} "
            f"map_odom_jump_count={_fmt_value(metrics['map_odom_jump_count'])} "
            f"map_odom_jump_max_deg={_fmt_value(metrics['map_odom_jump_max_abs_deg'])}"
        )


def _compare_sessions(
    baseline_path: Path,
    baseline: dict[str, Any],
    candidate_path: Path,
    candidate: dict[str, Any],
) -> dict[str, Any]:
    baseline_runs = _runs_by_scenario(baseline)
    candidate_runs = _runs_by_scenario(candidate)
    all_scenarios = sorted(set(baseline_runs.keys()) | set(candidate_runs.keys()))
    comparison_runs: list[dict[str, Any]] = []
    for scenario_id in all_scenarios:
        baseline_run = baseline_runs.get(scenario_id)
        candidate_run = candidate_runs.get(scenario_id)
        baseline_metrics = extract_key_metrics(baseline_run) if baseline_run else {}
        candidate_metrics = extract_key_metrics(candidate_run) if candidate_run else {}
        deltas = {
            metric_name: _delta_for_metric(
                metric_name,
                baseline_metrics.get(metric_name),
                candidate_metrics.get(metric_name),
            )
            for metric_name in KEY_METRICS
        }
        comparison_runs.append(
            {
                "scenario_id": scenario_id,
                "baseline_metrics": baseline_metrics,
                "candidate_metrics": candidate_metrics,
                "delta": deltas,
            }
        )
    return {
        "baseline": str(baseline_path),
        "candidate": str(candidate_path),
        "runs": comparison_runs,
    }


def _print_comparison(result: dict[str, Any]) -> None:
    print(f"Baseline: {result['baseline']}")
    print(f"Candidate: {result['candidate']}")
    for run in result["runs"]:
        print(f"  - {run['scenario_id']}")
        for metric_name in KEY_METRICS:
            print(
                f"    {metric_name}: "
                f"{_fmt_value(run['baseline_metrics'].get(metric_name))} -> "
                f"{_fmt_value(run['candidate_metrics'].get(metric_name))} "
                f"[{run['delta'][metric_name]}]"
            )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Summarize or compare benchmark JSON outputs."
    )
    parser.add_argument("files", nargs="*")
    parser.add_argument("--baseline", default="")
    parser.add_argument("--candidate", default="")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    if args.baseline and args.candidate:
        baseline_path = Path(args.baseline)
        candidate_path = Path(args.candidate)
        result = _compare_sessions(
            baseline_path,
            _load_session(baseline_path),
            candidate_path,
            _load_session(candidate_path),
        )
        if args.json:
            print(json.dumps(json_ready(result), indent=2, sort_keys=True))
            return
        _print_comparison(result)
        return

    if not args.files:
        raise RuntimeError("Provide files to summarize or use --baseline/--candidate")
    sessions = [(Path(path), _load_session(Path(path))) for path in args.files]
    if args.json:
        payload = [{"path": str(path), "session": session} for path, session in sessions]
        print(json.dumps(json_ready(payload), indent=2, sort_keys=True))
        return
    for path, session in sessions:
        _print_single_session(path, session)


if __name__ == "__main__":
    main()
