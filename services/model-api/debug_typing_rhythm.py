"""
Debug tool to visualize keystroke features and model confidence.
Helps understand what the model learned and test impostors.
"""
import json
import numpy as np
import sqlite3
from collections import defaultdict
from pathlib import Path


def load_user_samples(db_path, username):
    """Load all keystroke samples for a user from the database."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Get all keystroke_texts for this user
    cursor.execute("""
        SELECT kt.id, kt.keystroke_timings FROM keystroke_texts kt
        JOIN users u ON kt.user_id = u.id
        WHERE u.username = ? 
        ORDER BY kt.submitted_at
    """, (username,))
    
    samples = []
    for row in cursor.fetchall():
        if row['keystroke_timings']:
            try:
                data = json.loads(row['keystroke_timings'])
                samples.append({
                    'id': row['id'],
                    'data': data
                })
            except json.JSONDecodeError:
                continue
    
    conn.close()
    return samples


def extract_keystroke_timing(keystroke_data):
    """Extract timing features from keystroke events (matches server's keystroke-tracker.js)."""
    events = keystroke_data.get('events', [])
    
    dwell_times = []
    flight_times = []
    
    last_down = {}
    last_keyup_time = None
    
    for evt in events:
        if evt.get('eventType') == 'keydown':
            key_id = f"{evt.get('keyCode')}"
            last_down[key_id] = evt.get('timestampRelative', 0)
            
            # Calculate flight time (gap between keyup and keydown)
            if last_keyup_time is not None:
                flight = evt.get('timestampRelative', 0) - last_keyup_time
                if 0 <= flight < 10000:
                    flight_times.append(flight)
        
        elif evt.get('eventType') == 'keyup':
            key_id = f"{evt.get('keyCode')}"
            if key_id in last_down:
                dwell = evt.get('timestampRelative', 0) - last_down[key_id]
                if 0 <= dwell < 5000:
                    dwell_times.append(dwell)
                del last_down[key_id]
            
            last_keyup_time = evt.get('timestampRelative', 0)
    
    avg = lambda arr: np.mean(arr) if arr else 0
    std = lambda arr: np.std(arr) if arr else 0
    
    return {
        'avg_dwell_ms': round(avg(dwell_times), 2),
        'std_dwell_ms': round(std(dwell_times), 2),
        'min_dwell_ms': round(min(dwell_times), 2) if dwell_times else 0,
        'max_dwell_ms': round(max(dwell_times), 2) if dwell_times else 0,
        'avg_flight_ms': round(avg(flight_times), 2),
        'std_flight_ms': round(std(flight_times), 2),
        'min_flight_ms': round(min(flight_times), 2) if flight_times else 0,
        'max_flight_ms': round(max(flight_times), 2) if flight_times else 0,
        'num_dwell_samples': len(dwell_times),
        'num_flight_samples': len(flight_times),
        'dwell_variance_low': std(dwell_times) < 50 if dwell_times else True,  # Warning if no variance
        'flight_variance_low': std(flight_times) < 50 if flight_times else True,
    }


def analyze_user_profile(username, db_path='./server/db/users.db'):
    """Analyze a user's keystroke profile from database samples."""
    print(f"\n{'='*70}")
    print(f"KEYSTROKE PROFILE ANALYSIS: {username}")
    print(f"{'='*70}\n")
    
    samples = load_user_samples(db_path, username)
    
    if not samples:
        print(f"❌ No samples found for user '{username}'")
        return None
    
    print(f"✓ Found {len(samples)} keystroke samples\n")
    
    # Extract features from all samples
    all_features = []
    for i, sample in enumerate(samples, 1):
        features = extract_keystroke_timing(sample['data'])
        all_features.append(features)
        
        print(f"Sample {i}:")
        print(f"  Dwell Time:  {features['avg_dwell_ms']:6.1f}ms ± {features['std_dwell_ms']:5.1f}ms "
              f"(range: {features['min_dwell_ms']:5.1f} - {features['max_dwell_ms']:5.1f}ms)")
        print(f"  Flight Time: {features['avg_flight_ms']:6.1f}ms ± {features['std_flight_ms']:5.1f}ms "
              f"(range: {features['min_flight_ms']:5.1f} - {features['max_flight_ms']:5.1f}ms)")
        
        # Warnings for low variance
        if features['dwell_variance_low']:
            print(f"  ⚠️  LOW DWELL VARIANCE - typing is very consistent (could be too similar samples)")
        if features['flight_variance_low']:
            print(f"  ⚠️  LOW FLIGHT VARIANCE - gaps between keys are very consistent")
        print()
    
    # Calculate profile statistics
    print(f"\n{'─'*70}")
    print("USER PROFILE SUMMARY (across all samples):")
    print(f"{'─'*70}\n")
    
    avg_dwell_list = [f['avg_dwell_ms'] for f in all_features]
    avg_flight_list = [f['avg_flight_ms'] for f in all_features]
    
    profile = {
        'avg_dwell_across_samples': round(np.mean(avg_dwell_list), 2),
        'std_dwell_across_samples': round(np.std(avg_dwell_list), 2),
        'avg_flight_across_samples': round(np.mean(avg_flight_list), 2),
        'std_flight_across_samples': round(np.std(avg_flight_list), 2),
    }
    
    print(f"Typical Dwell Time:  {profile['avg_dwell_across_samples']:6.1f}ms ± {profile['std_dwell_across_samples']:5.1f}ms")
    print(f"Typical Flight Time: {profile['avg_flight_across_samples']:6.1f}ms ± {profile['std_flight_across_samples']:5.1f}ms")
    
    print(f"\n{'─'*70}")
    print("IMPOSTER DETECTION SCENARIOS:")
    print(f"{'─'*70}\n")
    
    # Test scenarios
    scenarios = [
        ('FAST_TYPING', {'avg_dwell_ms': 80, 'avg_flight_ms': 100}, 
         'Typing very quickly (all keys pressed fast, short gaps)'),
        ('SLOW_TYPING', {'avg_dwell_ms': 300, 'avg_flight_ms': 400}, 
         'Typing slowly (holds keys longer, bigger gaps)'),
        ('GENUINE_FAST', {'avg_dwell_ms': profile['avg_dwell_across_samples'] - 20, 
                          'avg_flight_ms': profile['avg_flight_across_samples'] - 20},
         'Typing slightly faster than usual'),
        ('GENUINE_SLOW', {'avg_dwell_ms': profile['avg_dwell_across_samples'] + 20,
                          'avg_flight_ms': profile['avg_flight_across_samples'] + 20},
         'Typing slightly slower than usual'),
    ]
    
    for scenario_name, scenario_times, description in scenarios:
        print(f"{scenario_name}:")
        print(f"  {description}")
        print(f"  Dwell: {scenario_times['avg_dwell_ms']:.1f}ms, Flight: {scenario_times['avg_flight_ms']:.1f}ms")
        
        # Simple distance metric
        dwell_diff = abs(scenario_times['avg_dwell_ms'] - profile['avg_dwell_across_samples'])
        flight_diff = abs(scenario_times['avg_flight_ms'] - profile['avg_flight_across_samples'])
        
        # Normalize by user's standard deviation
        dwell_std = max(profile['std_dwell_across_samples'], 1)
        flight_std = max(profile['std_flight_across_samples'], 1)
        
        dwell_sigma = dwell_diff / dwell_std
        flight_sigma = flight_diff / flight_std
        
        anomaly_score = (dwell_sigma + flight_sigma) / 2
        
        if anomaly_score < 1.0:
            result = "✓ LIKELY GENUINE (within normal variation)"
        elif anomaly_score < 2.0:
            result = "⚠️  POSSIBLY INTRUDER (outside normal range)"
        else:
            result = "❌ LIKELY INTRUDER (very different from learned pattern)"
        
        print(f"  Deviation: {anomaly_score:.2f}σ (dwell: {dwell_sigma:.2f}σ, flight: {flight_sigma:.2f}σ)")
        print(f"  → {result}\n")
    
    return profile


def main():
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python debug_typing_rhythm.py <username>")
        print("\nExample: python debug_typing_rhythm.py asem")
        sys.exit(1)
    
    username = sys.argv[1]
    
    try:
        analyze_user_profile(username)
    except FileNotFoundError as e:
        print(f"❌ Error: {e}")
        print("Make sure the server is running and the database exists at ./server/db/users.db")
        sys.exit(1)


if __name__ == '__main__':
    main()
