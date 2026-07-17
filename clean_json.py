import re
import json

def repair_and_clean_beer_json(input_path, output_path):
    print(f"Reading {input_path}...")
    with open(input_path, "r", encoding="utf-8") as f:
        raw_data = f.read()

    # 1. Fix unescaped physical newlines inside JSON string values
    # This regex finds text inside double quotes and converts real newlines to \n
    print("Fixing unescaped newlines...")
    fixed_newlines = re.sub(
        r'"[^"\\]*(?:\\.[^"\\]*)*"',
        lambda m: m.group(0).replace("\n", "\\n").replace("\r", "\\r"),
        raw_data
    )

    # 2. Reconstruct the truncated ending of the file
    # If it ends abruptly near "non_alc":"", we append the missing fields and close the braces
    if '"non_alc":""' in fixed_newlines and not fixed_newlines.strip().endswith("}"):
        print("Truncation detected. Repairing structural ending...")
        completion = (
            ', "other": "", "fri_am": "Yes", "fri_pm": "Yes", "sat_am": "Yes", '
            '"sat_pm": "Yes", "festival_rating_count": 0, "festival_average_rating": 0'
            "} } }"
        )
        fixed_newlines = fixed_newlines.strip() + completion

    # 3. Parse the data and resolve double-serialization
    try:
        data = json.loads(fixed_newlines)
        
        # If beer_data was double-serialized as a escaped string, parse it into native JSON
        if "beer_data" in data and isinstance(data["beer_data"], str):
            print("Resolving double-serialized string inside 'beer_data'...")
            data["beer_data"] = json.loads(data["beer_data"])
            
        # 4. Save clean, formatted JSON
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            
        print(f"Success! Cleaned and repaired JSON saved to: {output_path}")

    except json.JSONDecodeError as e:
        print(f"\nFailed to parse JSON. Error: {e}")
        # Print a snippet around the error to help debug
        start = max(0, e.pos - 40)
        end = min(len(fixed_newlines), e.pos + 40)
        print(f"Error context: ... {fixed_newlines[start:end]} ...")

if __name__ == "__main__":
    # Change these filenames to match your local setup
    repair_and_clean_beer_json("beers.json", "clean_beers.json")