-- Creates a SQL login that can ONLY read one table.
-- Run in SQL Server Management Studio (SSMS) as an administrator.
-- Replace MyDatabase, dbo.Customers and the password before running.
--
-- Even if the API code had a bug, this login has no permission to
-- insert, update or delete anything.

USE [master];
GO
CREATE LOGIN [api_reader]
    WITH PASSWORD = N'change-me-to-a-long-password',
         CHECK_POLICY = ON,
         DEFAULT_DATABASE = [MyDatabase];
GO

USE [MyDatabase];
GO
CREATE USER [api_reader] FOR LOGIN [api_reader];
GO

-- Read access to the single table the API exposes...
GRANT SELECT ON OBJECT::[dbo].[Customers] TO [api_reader];
-- ...and nothing that changes data.
DENY INSERT, UPDATE, DELETE, ALTER, EXECUTE ON SCHEMA::[dbo] TO [api_reader];
GO
