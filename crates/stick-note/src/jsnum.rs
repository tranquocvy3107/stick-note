//! A few of the ways JavaScript turns things into numbers. The Node.js server compared `Number(data.baseRev)` with
//! the revision, so a client that sent the revision as a string or left it out got the same answer from it as
//! it gets from this program.

use serde_json::Value;

/// `Number("...")` for the plain cases: decimal numbers, an empty string (0), `Infinity`. Anything else is NaN.
pub fn number_from_str(text: &str) -> f64 {
    let s = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if s.is_empty() {
        return 0.0;
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if looks_decimal(s) { s.parse::<f64>().unwrap_or(f64::NAN) } else { f64::NAN }
}

/// `[+-] digits [. digits] [e [+-] digits]` where either the integer or the fraction part may be empty (but not both).
fn looks_decimal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    if matches!(b.first(), Some(b'+' | b'-')) {
        i += 1;
    }
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int = digits(i);
    i += int;
    let mut frac = 0;
    if b.get(i) == Some(&b'.') {
        i += 1;
        frac = digits(i);
        i += frac;
    }
    if int + frac == 0 {
        return false;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp = digits(i);
        if exp == 0 {
            return false;
        }
        i += exp;
    }
    i == b.len()
}

/// `Number(value)` for a JSON value. A missing value (`None`) is `undefined`, which is NaN.
pub fn number_from_json(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => number_from_str(s),
        Some(Value::Array(_) | Value::Object(_)) => f64::NAN,
    }
}

/// JavaScript truthiness of a JSON value.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strings_become_numbers_the_way_javascript_does_it() {
        for (text, expected) in
            [("5", 5.0), (" 7 ", 7.0), ("", 0.0), ("   ", 0.0), ("1e3", 1000.0), (".5", 0.5), ("5.", 5.0), ("-2", -2.0), ("+3", 3.0)]
        {
            assert_eq!(number_from_str(text), expected, "{text:?}");
        }
        assert_eq!(number_from_str("Infinity"), f64::INFINITY);
        for text in ["abc", "1,5", "0x10", "inf", "nan", "NaN", "1e", "e5", ".", "+", "1 2", "--1", "5px", "1_000"] {
            assert!(number_from_str(text).is_nan(), "{text:?} must be NaN");
        }
    }

    #[test]
    fn json_values_become_numbers_the_way_javascript_does_it() {
        assert_eq!(number_from_json(Some(&json!(4))), 4.0);
        assert_eq!(number_from_json(Some(&json!("4"))), 4.0);
        assert_eq!(number_from_json(Some(&json!(null))), 0.0);
        assert_eq!(number_from_json(Some(&json!(true))), 1.0);
        assert!(number_from_json(None).is_nan(), "a missing value is undefined");
        assert!(number_from_json(Some(&json!({}))).is_nan());
        assert!(number_from_json(Some(&json!("x"))).is_nan());
    }

    #[test]
    fn truthiness_follows_javascript() {
        assert!(!truthy(&json!(null)) && !truthy(&json!(false)) && !truthy(&json!(0)) && !truthy(&json!("")));
        assert!(truthy(&json!("2026-01-01")) && truthy(&json!(1)) && truthy(&json!([])) && truthy(&json!({})));
    }
}
