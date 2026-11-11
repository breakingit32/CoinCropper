from server.labels import normalise_grade, parse_barcode, parse_label_text


def test_pcgs_plain_digits():
    i = parse_barcode("45678912")
    assert (i.service, i.cert) == ("PCGS", "45678912")


def test_ngc_cert_suffix():
    i = parse_barcode("4321987-004")
    assert (i.service, i.cert) == ("NGC", "4321987-004")


def test_qr_urls():
    i = parse_barcode("https://www.pcgs.com/cert/45678912")
    assert (i.service, i.cert) == ("PCGS", "45678912")
    i = parse_barcode("https://www.ngccoin.com/certlookup/4321987-004/")
    assert (i.service, i.cert) == ("NGC", "4321987-004")


def test_long_pcgs_barcode_uses_last_8():
    i = parse_barcode("0071336545678912")
    assert i.cert == "45678912"


def test_grades():
    assert normalise_grade("MS 65") == ("MS65", 65)
    assert normalise_grade("PF69 DCAM") == ("PR69 DCAM", 69)
    assert normalise_grade("MS-64+ RD") == ("MS64+ RD", 64)
    assert normalise_grade("nothing") == (None, None)
    assert normalise_grade("MS99") == (None, None)


def test_label_text():
    text = """1881-S $1
    MORGAN DOLLAR
    MS65
    PCGS #7144  45678912"""
    i = parse_label_text(text)
    assert i.year == "1881" and i.mint_mark == "S"
    assert i.grade == "MS65"
    assert i.cert == "45678912"
    assert i.pcgs_no == "7144"
    assert i.description == "1881-S $1"
