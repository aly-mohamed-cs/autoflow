// A small "ERP" desktop app used to test and demo desktop automation.
// Invoices are entered in a form and listed in a grid; saving takes a moment,
// like a real system, and returns a document number.
namespace DemoErp;

static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new InvoiceForm());
    }
}

sealed class InvoiceForm : Form
{
    readonly TextBox customer = new() { Name = "txtCustomer", AccessibleName = "Customer", Width = 240 };
    readonly TextBox invoice = new() { Name = "txtInvoice", AccessibleName = "Invoice number", Width = 240 };
    readonly TextBox amount = new() { Name = "txtAmount", AccessibleName = "Amount", Width = 120 };
    readonly ComboBox currency = new() { Name = "cboCurrency", AccessibleName = "Currency", DropDownStyle = ComboBoxStyle.DropDownList, Width = 120 };
    readonly CheckBox urgent = new() { Name = "chkUrgent", Text = "Urgent", AutoSize = true };
    readonly Button save = new() { Name = "btnSave", Text = "Save invoice", AutoSize = true };
    readonly Label status = new() { Name = "lblStatus", AutoSize = true, Text = "Ready" };
    readonly DataGridView grid = new() { Name = "gridInvoices", AccessibleName = "Saved invoices", Width = 520, Height = 180, ReadOnly = true, AllowUserToAddRows = false, RowHeadersVisible = false };
    readonly ListBox customers = new() { Name = "lstCustomers", AccessibleName = "Known customers", Width = 240, Height = 60 };
    int next = 1001;

    public InvoiceForm()
    {
        Text = "Demo ERP - Invoices";
        Width = 600;
        Height = 640;
        customers.Items.AddRange(["Acme", "Globex", "Initech"]);

        // A classic menu bar, for "Choose menu item".
        var menu = new MenuStrip { Name = "mainMenu" };
        var file = new ToolStripMenuItem("File");
        file.DropDownItems.Add(new ToolStripMenuItem("Clear form", null, (_, _) =>
        {
            customer.Clear();
            invoice.Clear();
            amount.Clear();
            status.Text = "Form cleared";
        }));
        var help = new ToolStripMenuItem("Help");
        help.DropDownItems.Add(new ToolStripMenuItem("About", null, (_, _) => status.Text = "Demo ERP 1.0"));
        menu.Items.AddRange([file, help]);
        MainMenuStrip = menu;
        StartPosition = FormStartPosition.CenterScreen;
        currency.Items.AddRange(["EGP", "USD", "EUR"]);
        grid.Columns.Add("Document", "Document");
        grid.Columns.Add("Invoice", "Invoice");
        grid.Columns.Add("Customer", "Customer");
        grid.Columns.Add("Amount", "Amount");
        grid.Columns.Add("Currency", "Currency");

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(16), AutoSize = true };
        void Row(string label, Control control)
        {
            layout.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left });
            layout.Controls.Add(control);
        }
        Row("Customer", customer);
        Row("Invoice number", invoice);
        Row("Amount", amount);
        Row("Currency", currency);
        Row("", urgent);
        Row("", save);
        Row("Status", status);
        Row("Known customers", customers);
        layout.Controls.Add(grid);
        layout.SetColumnSpan(grid, 2);
        Controls.Add(layout);
        Controls.Add(menu); // added last so it docks above the form

        save.Click += async (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(invoice.Text) || string.IsNullOrWhiteSpace(amount.Text) || currency.SelectedIndex < 0)
            {
                status.Text = "Invoice number, amount and currency are required";
                return;
            }
            save.Enabled = false;
            status.Text = "Saving...";
            await Task.Delay(500);
            var document = $"DOC-{next++}";
            grid.Rows.Add(document, invoice.Text, customer.Text, amount.Text, currency.Text);
            status.Text = $"Saved {grid.Rows[grid.Rows.Count - 1].Cells[1].Value} as {document}";
            invoice.Clear();
            amount.Clear();
            customer.Clear();
            urgent.Checked = false;
            save.Enabled = true;
        };
    }
}
