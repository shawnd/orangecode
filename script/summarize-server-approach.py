#!/usr/bin/env python3
"""Print completed-run medians/ranges and candidate changes; never rewrite evidence."""
import argparse
import json
import pathlib
import statistics


def distribution(values):
    return {'median': statistics.median(values), 'min': min(values), 'max': max(values)}


def summarize(report):
    groups = []
    runs = [run for run in report['runs'] if run.get('success') and not run.get('errors')
            and run.get('cleanup', {}).get('finished')]
    for phase, count in sorted({(run['phase'], run['count']) for run in runs}):
        group = {'phase': phase, 'count': count, 'arms': {}, 'candidate_change_pct': {}, 'paired_change_pct': {}}
        values = {}
        for arm in ('baseline', 'candidate'):
            rows = [run for run in runs if run['phase'] == phase and run['count'] == count and run['arm'] == arm]
            if not rows:
                continue
            measured = {}
            for run in rows:
                idle = run['medians']['idle']
                row = {'idle_pss_mib': idle['pss_kib'] / 1024, 'idle_rss_mib': idle['rss_kib'] / 1024,
                       'idle_swap_pss_mib': idle['swappss_kib'] / 1024,
                       'startup_cpu_ms': run['startup_cpu_ms'],
                       'post_readiness_cpu_ms': run['post_readiness_cpu_ms'],
                       'settled_cpu_ms': idle['cpu_ms'],
                       'settled_cpu_ms_per_s': idle['cpu_ms'] / idle['elapsed_s'],
                       'first_client_paint_ms': run['readiness'][0]['paint_ms'],
                       'first_client_backend_ready_ms': run['readiness'][0]['backend_ready_ms'],
                       'first_client_usable_ms': run['readiness'][0]['usable_ms'],
                       'fleet_usable_elapsed_s': run['fleet_usable_elapsed_s']}
                if count > 1:
                    row['later_client_usable_ms'] = statistics.median(r['usable_ms'] for r in run['readiness'][1:])
                    row['later_client_backend_ready_ms'] = statistics.median(r['backend_ready_ms'] for r in run['readiness'][1:])
                if phase == 'active':
                    row.update({'active_pss_mib': run['medians']['text-active']['pss_kib'] / 1024,
                                'active_rss_mib': run['medians']['text-active']['rss_kib'] / 1024,
                                'active_swap_pss_mib': run['medians']['text-active']['swappss_kib'] / 1024,
                                'active_window_cpu_ms': run['medians']['text-active']['cpu_ms'],
                                'active_total_cpu_ms': run['active']['cpu_ms'],
                                'four_held_elapsed_s': run['active']['time_to_four_held_s'],
                                'active_completion_elapsed_s': run['active']['completion_elapsed_s'],
                                'provider_request_bytes': run['active']['request_bytes'],
                                'provider_response_bytes': run['active']['response_bytes'],
                                'main_calls': run['active']['main_calls']})
                measured[run['repeat']] = row
            values[arm] = measured
            group['arms'][arm] = {'completed_repeats': sorted(measured),
                'metrics': {key: distribution([row[key] for row in measured.values()])
                            for key in next(iter(measured.values()))}}
        if len(values) == 2:
            for key in group['arms']['baseline']['metrics']:
                baseline = group['arms']['baseline']['metrics'][key]['median']
                candidate = group['arms']['candidate']['metrics'][key]['median']
                group['candidate_change_pct'][key] = (candidate / baseline - 1) * 100 if baseline else None
                paired = [(values['candidate'][repeat][key] / values['baseline'][repeat][key] - 1) * 100
                          for repeat in values['baseline'].keys() & values['candidate'].keys()
                          if values['baseline'][repeat][key]]
                group['paired_change_pct'][key] = distribution(paired) if paired else None
        groups.append(group)
    return {'binaries': report['binaries'], 'finished': report.get('finished', False), 'groups': groups,
            'skipped_unsafe_arms': [run for run in report['runs'] if run.get('skipped')],
            'failed_or_incomplete_runs': [run['root'] for run in report['runs'] if run not in runs and not run.get('skipped')],
            'method': report['method']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('results', type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(summarize(json.loads(args.results.read_text())), indent=2))
