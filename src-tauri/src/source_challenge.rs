// Shared by native HTTP and WebView response validation. A redirect path alone
// is not enough: an ordinary source may legitimately use /_c or /_v.
pub(crate) fn is_dle_guard_page(body: &str) -> bool {
    let prefix: String = body.chars().take(24_000).collect();
    let lower = prefix.to_ascii_lowercase();
    lower.contains("pow_nonce") && (lower.contains("/_c") || lower.contains("/_v"))
}

#[cfg(test)]
mod tests {
    use super::is_dle_guard_page;

    #[test]
    fn requires_guard_markers_together() {
        assert!(is_dle_guard_page(
            "<script>const pow_nonce='fixture'; fetch('/_v')</script>"
        ));
        assert!(is_dle_guard_page(
            "<form action='/_c'><input name='pow_nonce'></form>"
        ));
        assert!(!is_dle_guard_page("<p>A comic about pow_nonce</p>"));
        assert!(!is_dle_guard_page("<a href='/_comics'>Comics</a>"));
    }

    #[test]
    fn ignores_markers_outside_the_document_prefix() {
        let body = format!("{}pow_nonce /_v", "é".repeat(24_000));
        assert!(!is_dle_guard_page(&body));
    }
}
