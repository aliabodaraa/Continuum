"""
Test tool to verify model predictions with different keystroke patterns.
Helps understand if the model can detect impostors vs genuine users.
"""
import json
import requests
import numpy as np
from typing import List, Dict


def create_keystroke_window(dwell_times: List[float], flight_times: List[float]) -> Dict:
    """
    Create a keystroke window matching the model input format.
    The model expects shape (50, 3) with features: [dwell, dd_time, ud_time]
    
    Args:
        dwell_times: list of dwell times (key hold duration in ms)
        flight_times: list of flight times (gap between keystrokes in ms)
    
    Returns:
        dict with 'window' key containing the feature array
    """
    window_size = 50
    
    # Pad or truncate to window size
    dwell_padded = (dwell_times + [0] * window_size)[:window_size]
    flight_padded = (flight_times + [0] * window_size)[:window_size]
    
    # Create the feature matrix (50, 3)
    # Format: [dwell_time, down-down_time, up-down_time]
    features = []
    for i in range(window_size):
        dwell = dwell_padded[i] if i < len(dwell_times) else 0
        flight = flight_padded[i] if i < len(flight_times) else 0
        # up-down time = time from key release to next key down (similar to flight)
        ud_time = flight
        features.append([dwell, flight, ud_time])
    
    return {
        'window': [features]  # Model expects batch dimension
    }


def test_keystroke_pattern(username: str, pattern_name: str, 
                          dwell_times: List[float], flight_times: List[float],
                          server_url: str = 'http://localhost:3000'):
    """
    Send a keystroke pattern to the model and get prediction.
    
    Args:
        username: username being authenticated
        pattern_name: descriptive name (e.g., 'GENUINE', 'FAST_IMPOSTER', 'SLOW_IMPOSTER')
        dwell_times: list of key hold durations (ms)
        flight_times: list of gaps between keystrokes (ms)
        server_url: the Continuum server URL
    
    Returns:
        dict with prediction and confidence
    """
    payload = create_keystroke_window(dwell_times, flight_times)
    
    try:
        response = requests.post(f'{server_url}/api/predict', json=payload, timeout=5)
        response.raise_for_status()
        
        result = response.json()
        prediction = result.get('prediction', [0, 0])
        
        # prediction is [P(intruder), P(genuine)]
        intruder_prob = prediction[0] if isinstance(prediction, list) else 0
        genuine_prob = prediction[1] if isinstance(prediction, list) else 1 - intruder_prob
        
        # Normalize to 0-1
        total = intruder_prob + genuine_prob
        if total > 0:
            genuine_prob = genuine_prob / total
            intruder_prob = intruder_prob / total
        
        return {
            'pattern': pattern_name,
            'genuine_confidence': round(genuine_prob * 100, 2),
            'intruder_confidence': round(intruder_prob * 100, 2),
            'predicted_class': 'GENUINE' if genuine_prob > intruder_prob else 'INTRUDER',
            'dwell_avg_ms': round(np.mean(dwell_times), 2),
            'flight_avg_ms': round(np.mean(flight_times), 2),
        }
    
    except requests.exceptions.RequestException as e:
        return {
            'pattern': pattern_name,
            'error': str(e),
            'dwell_avg_ms': round(np.mean(dwell_times), 2),
            'flight_avg_ms': round(np.mean(flight_times), 2),
        }


def explain_model_decision(results):
    """
    Explain how the model makes decisions based on keystroke patterns.
    """
    print("\n" + "="*80)
    print("HOW THE MODEL DETECTS IMPOSTORS")
    print("="*80 + "\n")
    
    print("""
The Continuum model learns your UNIQUE TYPING RHYTHM by analyzing:

1. DWELL TIME (milliseconds)
   - How long you hold each key down
   - Fast typists: 80-120ms per key
   - Slow typists: 200-400ms per key
   - YOUR PATTERN IS UNIQUE TO YOU

2. FLIGHT TIME (milliseconds)
   - Gap between releasing one key and pressing the next
   - Reflects your thinking speed and finger coordination
   - Also unique to each person

3. RHYTHM CONSISTENCY
   - The model learns if you're a consistent typist
   - High variance = you type inconsistently
   - Low variance = your typing is predictable

EXAMPLE SCENARIOS:
""")
    
    for r in results:
        if 'error' not in r:
            confidence_indicator = "✓" if r['predicted_class'] == 'GENUINE' else "❌"
            print(f"\n{confidence_indicator} {r['pattern']}")
            print(f"   Dwell: {r['dwell_avg_ms']}ms, Flight: {r['flight_avg_ms']}ms")
            print(f"   Prediction: {r['genuine_confidence']}% GENUINE, {r['intruder_confidence']}% INTRUDER")


def test_user_authenticity(username: str, server_url: str = 'http://localhost:3000'):
    """
    Test various keystroke patterns to verify the model can distinguish genuine from impostor.
    """
    print(f"\n{'='*80}")
    print(f"MODEL PREDICTION TEST: {username}")
    print(f"{'='*80}\n")
    
    print("Testing different keystroke patterns to verify model can detect impostors...\n")
    
    # Test patterns
    test_cases = [
        # Scenario 1: Genuine user (normal speed)
        {
            'name': '✓ GENUINE - Normal typing speed',
            'dwell': [120, 130, 125, 140, 115] * 10,  # Repeating pattern of ~125ms dwell
            'flight': [80, 75, 85, 70, 90] * 10,      # Repeating pattern of ~80ms flight
        },
        # Scenario 2: Fast imposter (very fast clicks)
        {
            'name': '❌ FAST IMPOSTER - Very rapid typing',
            'dwell': [40, 45, 50, 35, 55] * 10,  # Much shorter dwell (40-50ms)
            'flight': [20, 25, 30, 15, 35] * 10,  # Much shorter flight (20-30ms)
        },
        # Scenario 3: Slow imposter (very slow, deliberate typing)
        {
            'name': '❌ SLOW IMPOSTER - Very slow, deliberate typing',
            'dwell': [400, 450, 380, 420, 440] * 10,  # Much longer dwell (400-450ms)
            'flight': [300, 350, 280, 320, 340] * 10,  # Much longer flight (300-350ms)
        },
        # Scenario 4: Inconsistent typist (high variance in timing)
        {
            'name': '❌ ERRATIC IMPOSTER - Inconsistent rhythm',
            'dwell': [50, 200, 100, 300, 75, 250, 90, 180, 110, 220] * 5,  # Highly variable
            'flight': [30, 250, 60, 400, 40, 200, 50, 300, 35, 150] * 5,  # Highly variable
        },
        # Scenario 5: Slight variation (genuine user having a bad day)
        {
            'name': '✓ GENUINE VARIANT - Normal user typing slower',
            'dwell': [140, 145, 150, 135, 160] * 10,  # Slightly slower dwell (140-160ms)
            'flight': [95, 90, 100, 85, 105] * 10,    # Slightly longer flight (90-105ms)
        },
    ]
    
    results = []
    for test_case in test_cases:
        result = test_keystroke_pattern(
            username,
            test_case['name'],
            test_case['dwell'][:50],  # Take first 50
            test_case['flight'][:50],
            server_url
        )
        results.append(result)
    
    # Display results
    print(f"{'─'*80}")
    print(f"{'Pattern':<45} {'Dwell':<10} {'Flight':<10} {'Prediction':<25}")
    print(f"{'─'*80}")
    
    for r in results:
        if 'error' in r:
            print(f"{r['pattern']:<45} {r['dwell_avg_ms']:<10} {r['flight_avg_ms']:<10} ERROR: {r['error']}")
        else:
            pred_str = f"{r['predicted_class']} ({r['genuine_confidence']}%)"
            print(f"{r['pattern']:<45} {r['dwell_avg_ms']:<10} {r['flight_avg_ms']:<10} {pred_str:<25}")
    
    print(f"\n{'─'*80}")
    print("ANALYSIS:")
    print(f"{'─'*80}")
    
    genuine_correct = sum(1 for r in results if 'error' not in r and 
                         'GENUINE' in r['pattern'] and r['predicted_class'] == 'GENUINE')
    imposter_correct = sum(1 for r in results if 'error' not in r and 
                          'IMPOSTER' in r['pattern'] and r['predicted_class'] == 'INTRUDER')
    genuine_total = sum(1 for r in results if 'GENUINE' in r['pattern'] and 'error' not in r)
    imposter_total = sum(1 for r in results if 'IMPOSTER' in r['pattern'] and 'error' not in r)
    
    print(f"\n✓ Genuine Detection: {genuine_correct}/{genuine_total} correct")
    print(f"✓ Imposter Detection: {imposter_correct}/{imposter_total} correct")
    
    if genuine_correct == genuine_total and imposter_correct == imposter_total:
        print(f"\n✅ MODEL IS WORKING WELL - Correctly identifies both genuine and impostor patterns")
    elif imposter_correct < imposter_total:
        print(f"\n⚠️  MODEL ISSUE - Not detecting some impostor patterns!")
        print(f"   This suggests training samples were too limited or patterns not distinct enough.")
    else:
        print(f"\n⚠️  MODEL ISSUE - Some genuine patterns were rejected!")
        print(f"   This suggests training was too strict or insufficient variance in samples.")
    
    explain_model_decision(results)


def main():
    import sys
    
    username = sys.argv[1] if len(sys.argv) > 1 else 'asem'
    server_url = sys.argv[2] if len(sys.argv) > 2 else 'http://localhost:3000'
    
    test_user_authenticity(username, server_url)


if __name__ == '__main__':
    main()
