def invoice_total(lines):
    return sum(l["amount"] for l in lines)
