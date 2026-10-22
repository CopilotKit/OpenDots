import json
from typing import Dict, Any

def run_code(code_snippet: str) -> Dict[str, Any]:
    """
    Executes a given Python code snippet and returns the result.
    Assumes the code snippet prints its output or assigns it to 'result'.
    """
    # Setup environment for execution
    exec_globals = {}
    try:
        # Execute the code in the defined global scope
        exec(code_snippet, exec_globals)

        # Check if a variable named 'result' was assigned by the snippet
        if 'result' in exec_globals:
            return {
                "status": "SUCCESS",
                "output": str(exec_globals['result']),
                "message": "Code executed successfully and returned a value."
            }
        else:
            # If no explicit result variable, capture the output (assuming print statements)
            # Note: Capturing stdout perfectly requires more complex redirection, 
            # but for simplicity, we'll assume 'result' is used or rely on basic execution.
            return {
                "status": "SUCCESS",
                "output": "Execution complete. Check console output (if available).",
                "message": "Code executed successfully."
            }

    except Exception as e:
        # Handle any runtime errors during execution
        return {
            "status": "ERROR",
            "output": str(e),
            "message": f"Execution failed due to an error: {type(e).__name__}"
        }

def main():
    """
    Main entry point for the code_runner server. 
    In a real MCP setup, this would parse arguments from the command line/API call.
    For now, we simulate receiving input via a JSON argument structure.
    """
    import sys
    try:
        # Attempt to read JSON input from stdin (standard for CLI tools)
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({"status": "ERROR", "output": "No input provided.", "message": "A code snippet must be passed."}))
            return

        args = json.loads(input_data)
        code_snippet = args.get("code")

        if not code_snippet:
             print(json.dumps({"status": "ERROR", "output": "Missing 'code' key in input JSON.", "message": "Input must contain a 'code' field."}))
             return

        result = run_code(code_snippet)
        # Print the result dictionary as a JSON string to stdout, which MCP reads
        print(json.dumps(result))

    except json.JSONDecodeError:
        print(json.dumps({"status": "ERROR", "output": "Invalid JSON format.", "message": "Input must be valid JSON."}))
    except Exception as e:
        print(json.dumps({"status": "CRITICAL_ERROR", "output": str(e), "message": f"A critical error occurred during execution setup: {type(e).__name__}"}))

if __name__ == "__main__":
    main()