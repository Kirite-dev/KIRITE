#!/usr/bin/env python3
"""
Rewrite all commits in this repo:
  - Author: Kirite-dev <256582581+Kirite-dev@users.noreply.github.com>
  - Dates: redistributed across 2026-01-22 14:30 → 2026-04-10 17:00
  - Spacing: sparse and natural with multi-day gaps,
    weekends quieter, occasional bursts
"""
import subprocess, random, sys, os
from datetime import datetime, timedelta, timezone

random.seed(42)

NAME  = "Kirite-dev"
EMAIL = "256582581+Kirite-dev@users.noreply.github.com"

# Repo created 2026-01-22 14:16:23Z; first commit must be after that.
START = datetime(2026, 1, 22, 14, 30, 0, tzinfo=timezone.utc)
END   = datetime(2026, 4, 10, 17,  0, 0, tzinfo=timezone.utc)

def list_commits():
    out = subprocess.check_output(
        ["git", "log", "--reverse", "--format=%H"], text=True
    ).strip().split("\n")
    return out

commits = list_commits()
n = len(commits)
print(f"rewriting {n} commits")

# ---------- Generate sparse, irregular timestamps ----------
total_seconds = int((END - START).total_seconds())

# 1. Pick "active days" — not every day in the range, just a subset
total_days = (END.date() - START.date()).days + 1
day_offsets = list(range(total_days))

# Force-include first and last days
mandatory = {0, total_days - 1}

# Pick ~ n // 1.8 active days so commits cluster
target_active_days = max(min(n // 2, total_days), n // 3)
random.shuffle(day_offsets)
active_days = sorted(set(day_offsets[:target_active_days]) | mandatory)

# 2. Inject natural multi-day gaps (3-5 day silences ~3 times)
# by REMOVING some active days
gap_count = 3
for _ in range(gap_count):
    if len(active_days) < 10:
        break
    # pick a random middle day, drop a 3-5 day window starting there
    pivot_idx = random.randint(2, len(active_days) - 5)
    pivot_day = active_days[pivot_idx]
    gap_len = random.randint(3, 5)
    active_days = [d for d in active_days
                   if not (pivot_day <= d < pivot_day + gap_len)]
    # ensure mandatory survive
    for m in mandatory:
        if m not in active_days:
            active_days.append(m)
    active_days = sorted(set(active_days))

# 3. Distribute commits across active days
# weight: weekdays 1.0, weekends 0.3
def weight(day_offset):
    d = START.date() + timedelta(days=day_offset)
    return 0.3 if d.weekday() >= 5 else 1.0

weights = [weight(d) for d in active_days]
total_w = sum(weights)
# raw share
raw = [w / total_w * n for w in weights]
counts = [int(x) for x in raw]
# distribute remainder
remainder = n - sum(counts)
# fractional parts
frac_idx = sorted(range(len(active_days)),
                  key=lambda i: raw[i] - counts[i], reverse=True)
for i in frac_idx[:remainder]:
    counts[i] += 1

# Cap per-day max to avoid 20 commits/day
MAX_PER_DAY = 7
overflow = 0
for i in range(len(counts)):
    if counts[i] > MAX_PER_DAY:
        overflow += counts[i] - MAX_PER_DAY
        counts[i] = MAX_PER_DAY
# spread overflow
i = 0
while overflow > 0:
    if counts[i] < MAX_PER_DAY:
        counts[i] += 1
        overflow -= 1
    i = (i + 1) % len(counts)

# 4. Generate timestamps within each active day
timestamps = []
for day_offset, c in zip(active_days, counts):
    if c == 0:
        continue
    base = START + timedelta(days=day_offset - active_days[0])
    base = datetime(base.year, base.month, base.day,
                    tzinfo=timezone.utc)
    # Pick c times within work hours, weighted toward 10-22h
    times = []
    for _ in range(c):
        # bell-ish around 14:00
        hour = max(7, min(23, int(random.gauss(14, 3.5))))
        minute = random.randint(0, 59)
        second = random.randint(0, 59)
        times.append(base + timedelta(hours=hour, minutes=minute, seconds=second))
    times.sort()
    timestamps.extend(times)

timestamps.sort()

# Sanity: must have exactly n
if len(timestamps) != n:
    print(f"timestamp count mismatch: got {len(timestamps)} need {n}")
    # pad/trim
    while len(timestamps) < n:
        timestamps.append(timestamps[-1] + timedelta(minutes=random.randint(15, 90)))
    timestamps = timestamps[:n]

# Force boundaries
timestamps[0] = max(timestamps[0], START)
timestamps[-1] = min(timestamps[-1], END)

# Force monotonic
for i in range(1, n):
    if timestamps[i] <= timestamps[i-1]:
        timestamps[i] = timestamps[i-1] + timedelta(minutes=random.randint(5, 25))

# Final cap
if timestamps[-1] > END:
    # squeeze
    span = (END - timestamps[0]).total_seconds()
    orig_span = (timestamps[-1] - timestamps[0]).total_seconds()
    if orig_span > 0:
        ratio = span / orig_span
        for i in range(1, n):
            delta = (timestamps[i] - timestamps[0]).total_seconds() * ratio
            timestamps[i] = timestamps[0] + timedelta(seconds=delta)

# Build env-filter mapping commit -> date
env_lines = []
for sha, ts in zip(commits, timestamps):
    iso = ts.strftime("%Y-%m-%dT%H:%M:%S+0000")
    env_lines.append(f'    "{sha}") export GIT_AUTHOR_DATE="{iso}"; export GIT_COMMITTER_DATE="{iso}";;')

env_filter = "case $GIT_COMMIT in\n" + "\n".join(env_lines) + "\nesac\n"

# Author rewrite
env_filter += f'''
export GIT_AUTHOR_NAME="{NAME}"
export GIT_AUTHOR_EMAIL="{EMAIL}"
export GIT_COMMITTER_NAME="{NAME}"
export GIT_COMMITTER_EMAIL="{EMAIL}"
'''

# Write filter to a file (too long for argv)
with open(".envfilter.sh", "w", newline="\n") as f:
    f.write(env_filter)

print(f"first  commit: {timestamps[0]}")
print(f"last   commit: {timestamps[-1]}")
print(f"active days  : {len([c for c in counts if c > 0])}")
print(f"total commits: {sum(counts)}")
print()
print("now run:")
print('  git filter-branch -f --env-filter "$(cat .envfilter.sh)" -- --all')
