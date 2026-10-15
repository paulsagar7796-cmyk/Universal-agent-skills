from app.billing import invoice_total


def test_invoice_total():
    assert invoice_total([{"amount": 2}, {"amount": 3}]) == 5
