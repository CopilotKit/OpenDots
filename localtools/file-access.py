import json
from typing import Dict, Any
import os

def read_file(path: str) -> Dict[str, Any]:
    """
    Reads the content of a specified file path.
    Returns structured data including status and message.
    """
    try:
        # Check if the file exists before attempting to open it
        if not os.path.exists(path):
            return {
                "status": "ERROR",
                "output": f"File not found at path: {path}",
                "message": "The specified file does not exist in the current directory structure."
            }
        
        # Open and read the file content
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        return {
            "status": "SUCCESS",
            "output": content,
            "message": f"Successfully read contents from: {path}"
        }

    except PermissionError:
        return {
            "status": "ERROR",
            "output": "Permission denied.",
            "message": f"The system lacks permission to read the file at path: {path}."
        }
    except Exception as e:
        # Catch other potential errors (e.g., encoding issues, IO errors)
        return {
            "status": "CRITICAL_ERROR",
            "output": str(e),
            "message": f"An unexpected error occurred during file reading: {type(e).__name__}"
        }

def main():
    """
    Main entry point for the file_access server.
    Reads input JSON from stdin, executes read_file, and prints result to stdout.
    """
    import sys
    try:
        # Attempt to read JSON input from stdin (standard for CLI tools)
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({"status": "ERROR", "output": "No input provided.", "message": "A file path must be passed in the JSON body."}))
            return

        args = json.loads(input_data)
        file_path = args.get("path")

        if not file_path:
             print(json.dumps({"status": "ERROR", "output": "Missing 'path' key in input JSON.", "message": "Input must contain a 'path' field specifying the target file."}))
             return

        result = read_file(file_path)
        # Print the result dictionary as a JSON string to stdout, which MCP reads
        print(json.dumps(result))

    except json.JSONDecodeError:
        print(json.dumps({"status": "ERROR", "output": "Invalid JSON format.", "message": "Input must be valid JSON."}))
    except Exception as e:
        print(json.dumps({"status": "CRITICAL_ERROR", "output": str(e), "message": f"A critical error occurred during execution setup: {type(e).__name__}"}))

if __name__ == "__main__":
    main()